/** What the bot knows about an open pull request after a poll. */
export interface PrFacts {
  number: number;
  title: string;
  url: string;
  /** GitHub login of the author. */
  author: string;
  headSha: string;
  ciState: 'pending' | 'success' | 'failure';
  failingChecks: string[];
  conflicts: boolean;
  /** Reviewers whose latest review requests changes. */
  changesRequestedBy: string[];
}

/** What the bot remembers about a pull request between polls, to alert only on changes. */
export interface PrMemory {
  headSha: string;
  ciState: string;
  conflicts: boolean;
  changesRequestedBy: string[];
  /** The commit whose failure was alerted; cleared when CI passes again. */
  alertedFailureSha: string | null;
}

export type AlertKind = 'ci-failed' | 'ci-fixed' | 'conflicts' | 'changes-requested';

/**
 * Alerts for what changed since the last poll: a CI failure (once per commit, so re-runs don't
 * repeat it), CI passing again after an alerted failure, merge conflicts appearing, and reviewers
 * newly requesting changes. "Waiting for review" is never alerted.
 */
export function alertsFor(
  before: PrMemory | undefined,
  now: PrFacts,
): { alerts: { kind: AlertKind; text: string }[]; memory: PrMemory } {
  const pr = `[#${now.number} ${now.title}](${now.url})`;
  const alerts: { kind: AlertKind; text: string }[] = [];
  let alertedFailureSha = before?.alertedFailureSha ?? null;
  if (now.ciState === 'failure' && alertedFailureSha !== now.headSha) {
    alerts.push({
      kind: 'ci-failed',
      text: `❌ CI failed on ${pr}: ${now.failingChecks.join(', ') || 'a check'}`,
    });
    alertedFailureSha = now.headSha;
  } else if (now.ciState === 'success' && alertedFailureSha) {
    alerts.push({ kind: 'ci-fixed', text: `✅ CI passes again on ${pr}` });
    alertedFailureSha = null;
  }
  if (now.conflicts && !before?.conflicts) {
    alerts.push({ kind: 'conflicts', text: `⚠️ ${pr} has merge conflicts` });
  }
  const known = new Set((before?.changesRequestedBy ?? []).map((r) => r.toLowerCase()));
  const newReviewers = now.changesRequestedBy.filter((r) => !known.has(r.toLowerCase()));
  if (newReviewers.length) {
    alerts.push({
      kind: 'changes-requested',
      text: `🔁 Changes requested on ${pr} by ${newReviewers.join(', ')}`,
    });
  }
  return {
    alerts,
    memory: {
      headSha: now.headSha,
      ciState: now.ciState,
      conflicts: now.conflicts,
      changesRequestedBy: now.changesRequestedBy,
      alertedFailureSha,
    },
  };
}

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);

/** The CI state of a commit from its check runs and commit statuses. No checks at all counts as pending. */
export function ciStateOf(
  checkRuns: { name: string; status: string; conclusion: string | null }[],
  statuses: { context: string; state: string }[],
): { state: 'pending' | 'success' | 'failure'; failing: string[] } {
  const failing = [
    ...checkRuns
      .filter((r) => r.status === 'completed' && FAILED_CONCLUSIONS.has(r.conclusion ?? ''))
      .map((r) => r.name),
    ...statuses.filter((s) => s.state === 'failure' || s.state === 'error').map((s) => s.context),
  ];
  if (failing.length) return { state: 'failure', failing };
  const pending =
    (!checkRuns.length && !statuses.length) ||
    checkRuns.some((r) => r.status !== 'completed') ||
    statuses.some((s) => s.state === 'pending');
  return { state: pending ? 'pending' : 'success', failing: [] };
}

/** Issue numbers a PR's text refers to in the same repo: `#12`, `acme/web#12` (closing keywords included). */
export function issueRefs(text: string, owner: string, repo: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(?:^|[^\w/#])(?:([\w.-]+)\/([\w.-]+))?#(\d+)\b/g)) {
    const sameRepo =
      !m[1] || (m[1].toLowerCase() === owner.toLowerCase() && m[2]!.toLowerCase() === repo.toLowerCase());
    const n = Number(m[3]);
    if (sameRepo && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Reviewers whose latest decisive review (comments don't count) requests changes, in review order. */
export function requestingChanges(reviews: { user: string; state: string }[]): string[] {
  const latest = new Map<string, string>();
  for (const r of reviews) {
    if (r.state === 'COMMENTED' || r.state === 'PENDING') continue;
    latest.delete(r.user);
    latest.set(r.user, r.state);
  }
  const requesting = new Set(
    [...latest].filter(([, state]) => state === 'CHANGES_REQUESTED').map(([user]) => user),
  );
  return reviews.map((r) => r.user).filter((u, i, all) => requesting.has(u) && all.indexOf(u) === i);
}
