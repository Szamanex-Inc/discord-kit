import type { StatusSpec } from '@discord-kit/config';
import { statusFromLabels, statusLabels } from './labels.ts';

/** The parts of a GitHub issue the bot uses. */
export interface GhIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  assignees: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * The ticket state an issue stands for. Closed: its status label if that status is done, else the
 * template's first done status (a template without done statuses keeps the current one). Open: its
 * status label; without one the current status stays, unless it is done (then the first status).
 */
export function stateFromIssue(
  issue: Pick<GhIssue, 'title' | 'state' | 'labels'>,
  template: StatusSpec[],
  prefix: string,
  currentStatus: string,
): { title: string; status: string } {
  const fromLabel = statusFromLabels(issue.labels, template, prefix);
  const isDone = (key: string | undefined) => Boolean(template.find((s) => s.key === key)?.done);
  let status: string;
  if (issue.state === 'closed') {
    status = isDone(fromLabel) ? fromLabel! : (template.find((s) => s.done)?.key ?? currentStatus);
  } else {
    status = fromLabel ?? (isDone(currentStatus) ? template[0]!.key : currentStatus);
  }
  return { title: issue.title, status };
}

/** An issue's labels for a status: other labels kept, status labels replaced by this status's label. */
export function labelsForStatus(
  current: string[],
  status: string,
  template: StatusSpec[],
  prefix: string,
): string[] {
  const labels = statusLabels(template, prefix);
  const statusNames = new Set(labels.map((l) => l.name.toLowerCase()));
  const label = labels.find((l) => l.key === status)?.name;
  return [...current.filter((l) => !statusNames.has(l.toLowerCase())), ...(label ? [label] : [])];
}

function dedupe(logins: string[]): string[] {
  const seen = new Set<string>();
  return logins.filter((l) => !seen.has(l.toLowerCase()) && seen.add(l.toLowerCase()));
}

/**
 * Issue assignees after a change in Discord: logins of people without a profile stay (the bot can't
 * know whether they still work on it), and the ticket's assignees with a profile are added.
 */
export function issueAssigneesFor(
  currentLogins: string[],
  ticketUserIds: string[],
  loginOf: (userId: string) => string | undefined,
  isKnownLogin: (login: string) => boolean,
): string[] {
  const keep = currentLogins.filter((l) => !isKnownLogin(l));
  const mapped = ticketUserIds.map(loginOf).filter((l): l is string => Boolean(l));
  return dedupe([...keep, ...mapped]);
}

/** Ticket assignees after a change on GitHub: members mapped from the logins, plus members without a profile. */
export function ticketAssigneesFor(
  issueLogins: string[],
  currentUserIds: string[],
  userOf: (login: string) => string | undefined,
  hasProfile: (userId: string) => boolean,
): string[] {
  const mapped = issueLogins.map(userOf).filter((id): id is string => Boolean(id));
  const keep = currentUserIds.filter((id) => !hasProfile(id));
  return [...new Set([...mapped, ...keep])];
}

/** A change made in Discord in the last `graceMs` may still be on its way to GitHub: polls leave it alone. */
export function withinGrace(lastLocalChangeAt: string | undefined, now: Date, graceMs = 120_000): boolean {
  return lastLocalChangeAt !== undefined && now.getTime() - new Date(lastLocalChangeAt).getTime() < graceMs;
}

// Kept here for the github module's callers; it lives with the other input parsers.
export { parseIssueRef } from '../projects/keys.ts';
