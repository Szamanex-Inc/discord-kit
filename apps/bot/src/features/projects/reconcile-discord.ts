import { DiscordAPIError, RESTJSONErrorCodes, type AnyThreadChannel, type ForumChannel } from 'discord.js';
import type { StatusSpec } from '@discord-kit/config';
import type { FeatureContext } from '../../feature.ts';
import { tagIdFor } from './channels.ts';
import { registerPost, shouldRegisterPost } from './intake.ts';
import {
  decideStartup,
  decideTagEdit,
  decideTitleEdit,
  missingTags,
  needsControlCheck,
} from './reconcile.ts';
import { controlMessage, statusOf } from './render.ts';
import { projectsStore, type Project, type Ticket } from './store.ts';
import {
  announce,
  applyTicketChange,
  boardHooks,
  forumOf,
  projectTemplate,
  recentEdits,
  syncPost,
} from './tickets.ts';

/** Who made an edit in Discord is unknown; activity lines then say "changed in Discord". */
const IN_DISCORD = '';

function tagKeys(forum: ForumChannel, template: StatusSpec[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of template) {
    const id = tagIdFor(forum, s);
    if (id) map.set(id, s.key);
  }
  return map;
}

/** The ticket of a thread in its project's forum, if any. */
function ticketOf(
  ctx: FeatureContext,
  thread: AnyThreadChannel,
): { ticket: Ticket; project: Project } | undefined {
  const store = projectsStore(ctx.db);
  const ticket = store.ticketByThread(thread.id);
  if (!ticket || ticket.deleted) return undefined;
  const project = store.project(ticket.projectId);
  if (!project || project.forumId !== thread.parentId) return undefined;
  return { ticket, project };
}

/** A post's tags or name changed. The bot's own edits are skipped; hand edits are adopted or corrected. */
export async function onThreadUpdate(
  ctx: FeatureContext,
  before: AnyThreadChannel,
  after: AnyThreadChannel,
): Promise<void> {
  const found = ticketOf(ctx, after);
  if (!found || recentEdits.isRecent(after.id, after.appliedTags, after.name)) return;
  const { project } = found;
  let { ticket } = found;
  const store = projectsStore(ctx.db);
  const forum = forumOf(ctx, project);
  if (!forum) return;

  if (before.appliedTags.join() !== after.appliedTags.join()) {
    const template = projectTemplate(ctx, project);
    const decision = decideTagEdit(after.appliedTags, tagKeys(forum, template), ticket.status);
    if (decision.action === 'adopt') {
      const from = ticket.status;
      ticket = store.setStatus(ticket.id, decision.status, IN_DISCORD, 'tag-edit') ?? ticket;
      await applyTicketChange(ctx, project, ticket, {
        type: 'status',
        from,
        to: decision.status,
        actor: IN_DISCORD,
      });
    } else if (decision.action === 'restore') {
      await syncPost(ctx, project, ticket, {
        note: 'Status tags are set by the bot: pick one status tag, or use the **Move** menu.',
      });
    }
  }

  if (before.name !== after.name) {
    const decision = decideTitleEdit(after.name, ticket.key, ticket.title);
    if (decision.title) {
      const from = ticket.title;
      ticket = store.setTitle(ticket.id, decision.title, IN_DISCORD, 'title-edit') ?? ticket;
      await applyTicketChange(ctx, project, ticket, {
        type: 'title',
        from,
        to: decision.title,
        actor: IN_DISCORD,
      });
    } else if (decision.rename) {
      await syncPost(ctx, project, ticket);
    }
  }
}

/** A post was deleted by hand: the ticket is marked deleted (its history stays). */
export async function onThreadDelete(ctx: FeatureContext, thread: AnyThreadChannel): Promise<void> {
  const found = ticketOf(ctx, thread);
  if (!found) return;
  if (!projectsStore(ctx.db).markDeleted(found.ticket.id, IN_DISCORD, 'system')) return;
  await announce(ctx, found.project, found.ticket, { type: 'deleted', actor: IN_DISCORD });
}

/** Posts and pins a ticket's controls again (the old control message is gone). */
async function restoreControlMessage(
  ctx: FeatureContext,
  project: Project,
  ticket: Ticket,
  thread: AnyThreadChannel,
): Promise<void> {
  if (thread.archived) await thread.setArchived(false, 'restoring ticket controls');
  const control = await thread.send({
    ...controlMessage(ticket, projectTemplate(ctx, project), {
      showBody: thread.ownerId === ctx.client.user.id,
    }),
    allowedMentions: { parse: [] },
  });
  await control.pin('ticket controls').catch(() => {});
  projectsStore(ctx.db).attachThread(ticket.id, thread.id, control.id);
}

/** A control message or board message was deleted: post the control message again, or redraw the board. */
export async function onMessageDelete(
  ctx: FeatureContext,
  messageId: string,
  channelId: string,
): Promise<void> {
  const store = projectsStore(ctx.db);
  const ticket = store.ticketByThread(channelId);
  if (ticket && !ticket.deleted && ticket.controlMessageId === messageId) {
    const thread = await ctx.guild.channels.fetch(channelId).catch(() => null);
    if (thread?.isThread())
      await restoreControlMessage(ctx, store.project(ticket.projectId)!, ticket, thread);
    return;
  }
  const project = store.projectByChannel(channelId);
  if (project?.boardId === channelId && Object.values(project.boardMessageIds).includes(messageId)) {
    boardHooks.changed(project.id);
  }
}

export interface ReconcileResult {
  adopted: number;
  fixed: number;
  registered: number;
  deleted: number;
  missing: string[];
}

const isUnknownChannel = (e: unknown) =>
  e instanceof DiscordAPIError && e.code === RESTJSONErrorCodes.UnknownChannel;

/**
 * `thorough` (default, used by /project refresh) also checks the controls of archived done tickets;
 * the quick check on every start skips them (see needsControlCheck).
 *
 * Brings one project back in line after downtime: reports missing channels, adds missing status
 * tags, adopts hand edits made while the bot was offline, fixes broken status tags, turns untracked
 * posts into tickets, marks tickets whose post is gone as deleted, and redraws the board.
 */
export async function reconcileProject(
  ctx: FeatureContext,
  project: Project,
  opts: { thorough?: boolean } = {},
): Promise<ReconcileResult> {
  const result: ReconcileResult = { adopted: 0, fixed: 0, registered: 0, deleted: 0, missing: [] };
  const store = projectsStore(ctx.db);
  const has = (id: string) => ctx.guild.channels.cache.has(id);
  if (!ctx.guild.roles.cache.has(project.roleId)) result.missing.push('role');
  for (const [name, id] of [
    ['category', project.categoryId],
    ['#tickets', project.forumId],
    ['#board', project.boardId],
    ['#activity', project.activityId],
  ] as const) {
    if (!has(id)) result.missing.push(name);
  }
  if (result.missing.length) {
    ctx.log.warn('projects', `${project.key} is missing: ${result.missing.join(', ')}`);
  }
  let forum = forumOf(ctx, project);
  if (!forum) return result;

  const template = projectTemplate(ctx, project);
  const missing = missingTags(template, forum.availableTags);
  if (missing.length) {
    const added = missing.map((s) => ({
      name: s.label,
      moderated: false,
      emoji: s.emoji ? { id: null, name: s.emoji } : null,
    }));
    // Use the edited channel: the cached one may not have the new tag ids yet.
    forum = await forum.setAvailableTags(
      [...forum.availableTags, ...added].slice(0, 20),
      'missing status tags',
    );
  }
  const keys = tagKeys(forum, template);

  const active = await forum.threads.fetchActive();
  const archived = await forum.threads.fetchArchived({ fetchAll: true });
  const threads = [...active.threads.values(), ...archived.threads.values()].filter(
    (t) => t.parentId === forum.id,
  );
  const seen = new Set<string>();
  for (const thread of threads) {
    seen.add(thread.id);
    const ticket = store.ticketByThread(thread.id);
    if (!ticket) {
      if (shouldRegisterPost(thread, ctx.client.user.id, new Set([forum.id]), false)) {
        await registerPost(ctx, project, thread);
        result.registered++;
      }
      continue;
    }
    if (ticket.deleted) continue;
    // Deleting an old (uncached) control message emits no event, so check it here.
    const checkControl = needsControlCheck({
      archived: Boolean(thread.archived),
      done: Boolean(statusOf(template, ticket.status)?.done),
      thorough: opts.thorough ?? true,
    });
    if (ticket.controlMessageId && checkControl) {
      const exists = await thread.messages.fetch(ticket.controlMessageId).then(
        () => true,
        (e: unknown) => !(e instanceof DiscordAPIError && e.code === RESTJSONErrorCodes.UnknownMessage),
      );
      if (!exists) {
        await restoreControlMessage(ctx, project, ticket, thread);
        result.fixed++;
      }
    }
    const d = decideStartup(
      { status: ticket.status, title: ticket.title },
      { appliedTagIds: thread.appliedTags, name: thread.name, archived: Boolean(thread.archived) },
      keys,
      ticket.key,
    );
    let current = ticket;
    if (d.status) {
      current = store.setStatus(ticket.id, d.status, IN_DISCORD, 'reconcile') ?? current;
      await applyTicketChange(ctx, project, current, {
        type: 'status',
        from: ticket.status,
        to: d.status,
        actor: IN_DISCORD,
      });
      result.adopted++;
    }
    if (d.title) {
      current = store.setTitle(ticket.id, d.title, IN_DISCORD, 'reconcile') ?? current;
      await applyTicketChange(ctx, project, current, {
        type: 'title',
        from: ticket.title,
        to: d.title,
        actor: IN_DISCORD,
      });
      result.adopted++;
    }
    if (!d.status && !d.title && (d.fixTags || d.rename)) {
      await syncPost(ctx, project, current);
      result.fixed++;
    }
  }

  // Tickets whose post was not among the forum's threads: deleted only if Discord says it is gone.
  for (const ticket of store.tickets(project.id)) {
    if (!ticket.threadId || seen.has(ticket.threadId)) continue;
    const gone = await ctx.guild.channels.fetch(ticket.threadId).then(
      () => false,
      (e: unknown) => isUnknownChannel(e),
    );
    if (gone && store.markDeleted(ticket.id, IN_DISCORD, 'reconcile')) {
      await announce(ctx, project, ticket, { type: 'deleted', actor: IN_DISCORD });
      result.deleted++;
    }
  }
  boardHooks.changed(project.id);
  return result;
}
