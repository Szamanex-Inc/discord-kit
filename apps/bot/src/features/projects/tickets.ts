import { ChannelType, type ForumChannel, type ThreadChannel } from 'discord.js';
import { DEFAULT_TEMPLATES, effectiveTemplates, featureConfig, type StatusSpec } from '@discord-kit/config';
import type { FeatureContext } from '../../feature.ts';
import { tagIdFor } from './channels.ts';
import { githubHooks } from './hooks.ts';
import { activityLine, controlMessage, postName, statusOf } from './render.ts';
import { RecentEdits } from './recent-edits.ts';
import { projectsStore, type Project, type Ticket, type TicketEventType } from './store.ts';

/** Post states the bot applied recently (see RecentEdits). */
export const recentEdits = new RecentEdits();

/** A ticket change to show; `origin: 'github'` marks changes that came from GitHub (never pushed back). */
export type TicketChange = {
  type: TicketEventType;
  from?: string | null;
  to?: string | null;
  actor: string;
  origin?: 'github';
};

/** Called after every ticket change; the board module replaces it to schedule a redraw. */
export const boardHooks = { changed: (_projectId: number): void => {} };

/**
 * The project's statuses. A template removed from the preset falls back to the built-in template of
 * the same name, else `dev`, so tickets stay usable (the status of each ticket is kept as is).
 */
/** Projects already warned about a missing template since the module started. */
const warnedTemplates = new Set<string>();

/** Forget the warnings, so a restart (or hot reload) warns again. */
export function resetTemplateWarnings(): void {
  warnedTemplates.clear();
}

export function projectTemplate(ctx: FeatureContext, project: Project): StatusSpec[] {
  const template = effectiveTemplates(featureConfig(ctx.preset, 'projects'))[project.template];
  if (template) return template;
  const warnKey = `${project.id}:${project.template}`;
  if (!warnedTemplates.has(warnKey)) {
    warnedTemplates.add(warnKey);
    ctx.log.warn(
      'projects',
      `template '${project.template}' of ${project.key} is not in the preset; using a built-in one`,
    );
  }
  return DEFAULT_TEMPLATES[project.template] ?? DEFAULT_TEMPLATES.dev!;
}

export function forumOf(ctx: FeatureContext, project: Project): ForumChannel | undefined {
  const channel = ctx.guild.channels.cache.get(project.forumId);
  return channel?.type === ChannelType.GuildForum ? channel : undefined;
}

async function threadOf(ctx: FeatureContext, ticket: Ticket): Promise<ThreadChannel | undefined> {
  if (!ticket.threadId) return undefined;
  const channel = await ctx.guild.channels.fetch(ticket.threadId).catch(() => null);
  return channel?.isThread() ? channel : undefined;
}

/** Status tag first, then any non-status tags people added by hand. */
export function desiredTags(
  forum: ForumChannel,
  template: StatusSpec[],
  status: string,
  current: string[],
): string[] {
  const statusTagIds = new Set(template.map((s) => tagIdFor(forum, s)).filter(Boolean));
  const tag = tagIdFor(forum, statusOf(template, status));
  return [...(tag ? [tag] : []), ...current.filter((id) => !statusTagIds.has(id))].slice(0, 5);
}

/** Creates the forum post of a ticket made with /ticket new; its starter message holds the controls. */
export async function postTicket(
  ctx: FeatureContext,
  project: Project,
  ticket: Ticket,
): Promise<ThreadChannel> {
  const forum = forumOf(ctx, project);
  if (!forum) throw new Error(`the #tickets forum of ${project.key} is missing`);
  const template = projectTemplate(ctx, project);
  const name = postName(ticket);
  const appliedTags = desiredTags(forum, template, ticket.status, []);
  const thread = await forum.threads.create({
    name,
    message: { ...controlMessage(ticket, template, { showBody: true }), allowedMentions: { parse: [] } },
    appliedTags,
  });
  recentEdits.record(thread.id, appliedTags, name);
  // The starter message of a forum post has the post's id.
  projectsStore(ctx.db).attachThread(ticket.id, thread.id, thread.id);
  return thread;
}

/** Posts a line in #activity (no pings) and tells the board. */
export async function announce(
  ctx: FeatureContext,
  project: Project,
  ticket: Ticket,
  event: TicketChange,
): Promise<void> {
  boardHooks.changed(project.id);
  const channel = ctx.guild.channels.cache.get(project.activityId);
  if (!channel?.isSendable()) return ctx.log.warn('projects', `#activity of ${project.key} is missing`);
  const content = activityLine(
    { key: ticket.key, title: ticket.title, ...event },
    projectTemplate(ctx, project),
  );
  await channel.send({ content, allowedMentions: { parse: [] } });
}

/**
 * Brings a ticket's post in line with the database: control message, status tag and name. Archived
 * posts are reopened for the edit; posts in a done status are archived afterwards. Every state the
 * bot applies is recorded in `recentEdits`, so the resulting thread updates are not taken for hand
 * edits.
 */
export async function syncPost(
  ctx: FeatureContext,
  project: Project,
  ticket: Ticket,
  opts: { note?: string } = {},
): Promise<void> {
  const template = projectTemplate(ctx, project);
  const thread = await threadOf(ctx, ticket);
  const forum = forumOf(ctx, project);
  if (!thread || !forum) return;
  if (thread.archived) await thread.setArchived(false, 'ticket changed');
  const showBody = ticket.controlMessageId === thread.id || thread.ownerId === ctx.client.user.id;
  if (ticket.controlMessageId) {
    const message = await thread.messages.fetch(ticket.controlMessageId).catch(() => null);
    await message?.edit({
      ...controlMessage(ticket, template, { showBody }),
      allowedMentions: { parse: [] },
    });
  }
  const appliedTags = desiredTags(forum, template, ticket.status, thread.appliedTags);
  const name = postName(ticket);
  if (appliedTags.join() !== thread.appliedTags.join() || thread.name !== name) {
    recentEdits.record(thread.id, appliedTags, name);
    await thread.edit({ appliedTags, name });
  }
  // Posted while the post is open: an archived post refuses new messages.
  if (opts.note) await thread.send({ content: opts.note, allowedMentions: { parse: [] } });
  if (statusOf(template, ticket.status)?.done) await thread.setArchived(true, 'ticket done');
}

/** Syncs the post after a change, then announces the change. */
export async function applyTicketChange(
  ctx: FeatureContext,
  project: Project,
  ticket: Ticket,
  event: TicketChange,
): Promise<void> {
  await syncPost(ctx, project, ticket);
  await announce(ctx, project, ticket, event);
  // Changes made in Discord go to the linked GitHub issue; changes from GitHub must not go back.
  if (event.origin !== 'github' && event.type !== 'description' && ticket.issue)
    githubHooks.ticketChanged?.(project, ticket);
}
