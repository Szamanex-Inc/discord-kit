import type { StatusSpec } from '@discord-kit/config';
import { postName, splitPostName } from './render.ts';

export type TagDecision = { action: 'adopt'; status: string } | { action: 'restore' } | { action: 'none' };

/**
 * A post's tags changed by hand. The current status is left out when counting, because Discord
 * saves each tick of the tag picker at once, so a switch passes through "old + new". Exactly one
 * other status: adopt it (the old tag is removed when the post is synced). Only the current status:
 * nothing to do. No status tag, or several new ones: put the stored status back. Tags that are not
 * statuses are ignored.
 */
export function decideTagEdit(
  appliedTagIds: string[],
  tagKeyById: Map<string, string>,
  dbStatus: string,
): TagDecision {
  const statuses = appliedTagIds.map((id) => tagKeyById.get(id)).filter((k): k is string => k !== undefined);
  const others = statuses.filter((k) => k !== dbStatus);
  if (others.length === 1) return { action: 'adopt', status: others[0]! };
  if (others.length === 0 && statuses.includes(dbStatus)) return { action: 'none' };
  return { action: 'restore' };
}

/**
 * A post was renamed by hand: adopt the new title (without the key) and put the key prefix back if
 * it was removed. A name that is only the key keeps the stored title.
 */
export function decideTitleEdit(
  newName: string,
  key: string,
  dbTitle: string,
): { title?: string; rename?: string } {
  const title = splitPostName(newName, key);
  const out: { title?: string; rename?: string } = {};
  if (title && title !== dbTitle) out.title = title;
  const expected = postName({ key, title: out.title ?? dbTitle });
  if (newName !== expected) out.rename = expected;
  return out;
}

/**
 * What to do with a post found at startup. The database only changes while the bot runs and
 * applies each change to Discord at once, so a difference comes from a hand edit made while the
 * bot was offline: Discord wins for a single status tag and for the title. Broken status tags are
 * fixed. Archived posts are reopened only when they have to be edited.
 */
export function decideStartup(
  db: { status: string; title: string },
  post: { appliedTagIds: string[]; name: string; archived: boolean },
  tagKeyById: Map<string, string>,
  key: string,
): { status?: string; title?: string; fixTags?: boolean; rename?: string; unarchive?: boolean } {
  const out: { status?: string; title?: string; fixTags?: boolean; rename?: string; unarchive?: boolean } =
    {};
  const tag = decideTagEdit(post.appliedTagIds, tagKeyById, db.status);
  if (tag.action === 'adopt') out.status = tag.status;
  if (tag.action === 'restore') out.fixTags = true;
  Object.assign(out, decideTitleEdit(post.name, key, db.title));
  if (post.archived && (out.fixTags || out.rename)) out.unarchive = true;
  return out;
}

/** Template statuses that have no forum tag with the same label (case-insensitive). */
export function missingTags(template: StatusSpec[], forumTags: { id: string; name: string }[]): StatusSpec[] {
  const names = new Set(forumTags.map((t) => t.name.toLowerCase()));
  return template.filter((s) => !names.has(s.label.toLowerCase()));
}

/**
 * Whether the startup check should verify a ticket's control message (one request per post). The
 * quick check on every start skips archived posts of done tickets, which are rarely touched;
 * `/project refresh` is thorough and checks them all.
 */
export function needsControlCheck(o: { archived: boolean; done: boolean; thorough: boolean }): boolean {
  return o.thorough || !(o.archived && o.done);
}
