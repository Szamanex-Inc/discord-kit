import type { ThreadChannel } from 'discord.js';
import type { FeatureContext } from '../../feature.ts';
import { githubHooks } from './hooks.ts';
import { controlMessage, postName } from './render.ts';
import { projectsStore, type Project, type Ticket } from './store.ts';
import { announce, desiredTags, forumOf, projectTemplate, recentEdits } from './tickets.ts';

/** Runs `fn`; if it fails, waits `delayMs` and tries once more. Null when both attempts fail. */
export async function retryOnce<T>(fn: () => Promise<T>, delayMs = 1000): Promise<T | null> {
  try {
    return await fn();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return fn().catch(() => null);
  }
}

/**
 * Whether a new forum post should become a ticket: it is in a project forum, was not made by the
 * bot (posts from /ticket new are tickets already) and is not tracked yet.
 */
export function shouldRegisterPost(
  thread: { ownerId: string | null; parentId: string | null },
  botId: string,
  forumIds: Set<string>,
  alreadyTracked: boolean,
): boolean {
  return (
    Boolean(thread.parentId && forumIds.has(thread.parentId)) && thread.ownerId !== botId && !alreadyTracked
  );
}

// A live ThreadCreate and a reconciliation can discover the same post at the same time.
const pendingPosts = new Map<string, Promise<Ticket>>();

export function registerPost(ctx: FeatureContext, project: Project, thread: ThreadChannel): Promise<Ticket> {
  const existing = projectsStore(ctx.db).ticketByThread(thread.id);
  if (existing) return Promise.resolve(existing);
  const pending = pendingPosts.get(thread.id);
  if (pending) return pending;
  const registration = registerNewPost(ctx, project, thread).finally(() => pendingPosts.delete(thread.id));
  pendingPosts.set(thread.id, registration);
  return registration;
}

/**
 * Turns a post made by hand into a ticket: stores it (the post's title, and its first message as
 * the description), adds the ticket key to the name, applies the first status tag, and posts and
 * pins the bot's control message.
 */
async function registerNewPost(
  ctx: FeatureContext,
  project: Project,
  thread: ThreadChannel,
): Promise<Ticket> {
  const store = projectsStore(ctx.db);
  const template = projectTemplate(ctx, project);
  // Right after the post appears, Discord sometimes has not stored its first message yet.
  const starter = await retryOnce(() => thread.fetchStarterMessage());
  const ticket = store.createTicket(
    project.id,
    {
      title: thread.name.trim() || 'Untitled',
      body: starter?.content ?? '',
      status: template[0]!.key,
      createdBy: thread.ownerId ?? ctx.client.user.id,
    },
    'system',
  );
  const control = await thread.send({ ...controlMessage(ticket, template), allowedMentions: { parse: [] } });
  await control
    .pin('ticket controls')
    .catch((e: unknown) => ctx.log.warn('projects', `could not pin in ${ticket.key}`, e));
  store.attachThread(ticket.id, thread.id, control.id);
  const forum = forumOf(ctx, project);
  const name = postName(ticket);
  const appliedTags = forum
    ? desiredTags(forum, template, ticket.status, thread.appliedTags)
    : thread.appliedTags;
  recentEdits.record(thread.id, appliedTags, name);
  await thread.edit({ name, appliedTags });
  await announce(ctx, project, ticket, { type: 'created', to: ticket.status, actor: ticket.createdBy }).catch(
    (e: unknown) => ctx.log.warn('projects', `could not announce ${ticket.key}`, e),
  );
  await githubHooks.forumTicketCreated?.(project, store.ticket(ticket.id) ?? ticket);
  return store.ticket(ticket.id) ?? ticket;
}
