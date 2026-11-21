import type { StatusSpec } from '@discord-kit/config';
import type { Logger } from '../../log.ts';
import type { ProfilesStore } from '../projects/profiles.ts';
import type { Project, ProjectsStore, Ticket, TicketEventType } from '../projects/store.ts';
import { alertsFor, ciStateOf, issueRefs, requestingChanges } from './alerts.ts';
import type { GitHubClient } from './client.ts';
import type { GithubStore } from './store.ts';
import {
  issueAssigneesFor,
  labelsForStatus,
  stateFromIssue,
  ticketAssigneesFor,
  withinGrace,
  type GhIssue,
} from './sync.ts';

/** A ticket change to show in Discord; `origin: 'github'` marks changes that came from GitHub. */
export type ChangeEvent = {
  type: TicketEventType;
  from?: string | null;
  to?: string | null;
  actor: string;
  origin?: 'github';
};

/** What the engine needs from Discord (posts, activity, notes), so it can be tested without it. */
export interface DiscordSide {
  postTicket(project: Project, ticket: Ticket): Promise<void>;
  applyChange(project: Project, ticket: Ticket, event: ChangeEvent): Promise<void>;
  /** Redraws the ticket's post (control message) after a change that is not a ticket event. */
  refresh(project: Project, ticket: Ticket): Promise<void>;
  announce(project: Project, text: string): Promise<void>;
  note(ticket: Ticket, text: string): Promise<void>;
  /** A pull request alert: in the ticket's thread when there is one, else in #activity; pings `pingUserId` only. */
  alert(project: Project, ticket: Ticket | undefined, text: string, pingUserId?: string): Promise<void>;
}

const FROM_GITHUB = { actor: '', origin: 'github' } as const;
type PendingCreation = { repo: string; result: Promise<number> };
const creationsByStore = new WeakMap<ProjectsStore, Map<number, PendingCreation>>();
const issueWorkByStore = new WeakMap<ProjectsStore, Map<number, Promise<void>>>();

/**
 * Keeps tickets and GitHub issues in line. GitHub → Discord by polling (import, then changes since
 * the newest update seen); Discord → GitHub by pushing a ticket's state after each change there.
 * For linked tickets GitHub is the source of truth, except for changes made in Discord in the last
 * two minutes, which may still be on their way.
 */
export class SyncEngine {
  private readonly now: () => Date;
  private readonly creating: Map<number, PendingCreation>;

  constructor(
    private readonly deps: {
      client: GitHubClient;
      projects: ProjectsStore;
      repos: GithubStore;
      profiles: ProfilesStore;
      discord: DiscordSide;
      templateFor: (project: Project) => StatusSpec[];
      prefix: string;
      log: Logger;
      now?: () => Date;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
    this.creating = creationsByStore.get(deps.projects) ?? new Map();
    creationsByStore.set(deps.projects, this.creating);
  }

  private loginOf = (userId: string) => this.deps.profiles.profile(userId)?.githubLogin ?? undefined;
  private userOf = (login: string) => this.deps.profiles.userByGithubLogin(login);
  private hasProfile = (userId: string) => Boolean(this.loginOf(userId));
  /** Issue assignees no profile matches: they can't be assigned in Discord. */
  private unlinkedOf = (logins: string[]) => logins.filter((l) => !this.userOf(l));

  /**
   * Tells the ticket's assignees without a GitHub username, once per member and ticket, that they
   * are not assigned on GitHub and how to fix it. Sync rules don't change: they are just skipped.
   */
  private async noteMissingProfiles(ticket: Ticket, ref: string): Promise<void> {
    const { projects, repos, discord, log } = this.deps;
    const missing = ticket.assignees.filter((id) => !this.hasProfile(id));
    if (!missing.length) return;
    // The caller's copy may predate the post (e.g. /ticket new), so notes go to the current one.
    const current = projects.ticket(ticket.id) ?? ticket;
    for (const userId of missing) {
      if (!repos.markProfileNoted(ticket.id, userId)) continue;
      // A note that can't be posted must not look like a failed sync.
      await discord
        .note(
          current,
          `<@${userId}> has no GitHub username yet, so they are not assigned on ${ref}; they can set it with \`/profile edit\`.`,
        )
        .catch((e: unknown) => log.warn('github', `could not post a profile note in ${current.key}`, e));
    }
  }

  /** Turns the open issues created at or after the repo's `sync_from` into tickets. Returns how many. */
  async importRepo(repoId: number): Promise<number> {
    const { client, projects, repos, discord } = this.deps;
    const repo = repos.repo(repoId);
    const project = repo && projects.project(repo.projectId);
    if (!repo?.syncFrom || !project) return 0;
    const result = await client.listIssues(repo.owner, repo.name, { state: 'open' });
    if (result.notModified) return 0;
    await this.waitForIssueLinks(repo.owner, repo.name);
    let count = 0;
    for (const issue of result.issues) {
      if (
        issue.createdAt < repo.syncFrom ||
        projects.ticketByIssue(repo.owner, repo.name, issue.number) ||
        projects.wasLinkedToDeletedTicket(project.id, repo.owner, repo.name, issue.number)
      )
        continue;
      await this.ticketFromIssue(project, repo.owner, repo.name, issue, false);
      count++;
    }
    const since = newest(result.issues, repo.since);
    repos.setPollState(repo.id, { lastPollAt: this.now().toISOString(), since, etag: repo.etag });
    if (count)
      await discord.announce(
        project,
        `📥 imported ${count} issue${count === 1 ? '' : 's'} from ${repo.owner}/${repo.name}`,
      );
    return count;
  }

  /** Applies GitHub changes since the last poll; new open issues become tickets. */
  async pollRepo(repoId: number): Promise<{ changed: number; created: number }> {
    const { client, projects, repos } = this.deps;
    const counts = { changed: 0, created: 0 };
    const repo = repos.repo(repoId);
    const project = repo && projects.project(repo.projectId);
    // No import choice yet: nothing is synced until the member picks one.
    if (!repo?.syncFrom || !project) return counts;
    const result = await client.listIssues(repo.owner, repo.name, {
      state: 'all',
      ...(repo.since && { since: repo.since }),
      ...(repo.etag && { etag: repo.etag }),
    });
    const lastPollAt = this.now().toISOString();
    if (result.notModified) {
      repos.setPollState(repo.id, { lastPollAt, since: repo.since, etag: repo.etag });
      await this.pollPulls(repo.id, project);
      return counts;
    }
    await this.waitForIssueLinks(repo.owner, repo.name);
    for (const issue of result.issues) {
      const ticket = projects.ticketByIssue(repo.owner, repo.name, issue.number);
      if (ticket) {
        if (await this.applyIssue(project, ticket, issue)) counts.changed++;
      } else if (
        issue.state === 'open' &&
        issue.createdAt >= repo.syncFrom &&
        !projects.wasLinkedToDeletedTicket(project.id, repo.owner, repo.name, issue.number)
      ) {
        await this.ticketFromIssue(project, repo.owner, repo.name, issue, true);
        counts.created++;
      }
    }
    repos.setPollState(repo.id, {
      lastPollAt,
      since: newest(result.issues, repo.since),
      etag: result.etag ?? null,
    });
    await this.pollPulls(repo.id, project);
    return counts;
  }

  /**
   * Checks open pull requests and posts alerts for what changed: failing CI (once per commit), CI
   * passing again, merge conflicts, requested changes. A pull request is only looked at again when
   * it changed or its CI was still running.
   */
  async pollPulls(repoId: number, project: Project): Promise<void> {
    const { client, projects, repos, profiles, discord, log } = this.deps;
    const repo = repos.repo(repoId);
    if (!repo) return;
    try {
      for (const pull of await client.listOpenPulls(repo.owner, repo.name)) {
        const before = repos.prMemory(repo.id, pull.number);
        const unchanged = before?.headSha === pull.headSha && before.updatedAt === pull.updatedAt;
        if (unchanged && before.ciState !== 'pending') continue;
        const details = await client.pullDetails(repo.owner, repo.name, pull);
        const ci = ciStateOf(details.checkRuns, details.statuses);
        const { alerts, memory } = alertsFor(before, {
          ...pull,
          ciState: ci.state,
          failingChecks: ci.failing,
          conflicts: details.mergeableState === 'dirty',
          changesRequestedBy: requestingChanges(details.reviews),
        });
        repos.setPrMemory(repo.id, pull.number, { ...memory, updatedAt: pull.updatedAt });
        if (!alerts.length) continue;
        const ticket = issueRefs(`${pull.title}\n${pull.body}`, repo.owner, repo.name)
          .map((n) => projects.ticketByIssue(repo.owner, repo.name, n))
          .find((t) => t !== undefined);
        const ping = profiles.userByGithubLogin(pull.author);
        for (const alert of alerts) await discord.alert(project, ticket, alert.text, ping);
      }
    } catch (e) {
      log.error('github', `could not check the pull requests of ${repo.owner}/${repo.name}`, e);
    }
  }

  /** Polls every linked repo of one project (or of all projects), one after another. */
  async poll(projectId?: number): Promise<{ changed: number; created: number }> {
    const total = { changed: 0, created: 0 };
    await this.closeDeletedIssues(projectId);
    for (const repo of this.deps.repos.repos()) {
      if (projectId !== undefined && repo.projectId !== projectId) continue;
      try {
        const r = await this.pollRepo(repo.id);
        total.changed += r.changed;
        total.created += r.created;
      } catch (e) {
        this.deps.log.error('github', `could not sync ${repo.owner}/${repo.name}`, e);
      }
    }
    return total;
  }

  /** Serializes closing an issue with any earlier writes for its ticket, including across reloads. */
  private async runIssueWork(ticketId: number, work: () => Promise<void>): Promise<void> {
    const { projects } = this.deps;
    let pending = issueWorkByStore.get(projects);
    if (!pending) issueWorkByStore.set(projects, (pending = new Map()));
    const previous = pending.get(ticketId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    pending.set(ticketId, next);
    try {
      await next;
    } finally {
      if (pending.get(ticketId) === next) pending.delete(ticketId);
    }
  }

  private async closeDeletedIssues(projectId?: number): Promise<void> {
    const { client, projects, log } = this.deps;
    for (const target of projects.pendingIssueClosures(projectId)) {
      const { ticketId, ticketKey, owner, name, number } = target;
      const stillLinked = () => {
        const link = projects.issueOf(ticketId);
        return (
          link?.owner.toLowerCase() === owner.toLowerCase() &&
          link.name.toLowerCase() === name.toLowerCase() &&
          link.number === number &&
          projects.projectByRepo(owner, name)?.id === target.projectId &&
          !projects.ticketByIssue(owner, name, number)
        );
      };
      await this.runIssueWork(ticketId, async () => {
        if (!projects.isIssueClosurePending(ticketId)) return;
        try {
          if (stillLinked()) {
            const issue = await client.getIssue(owner, name, number, { exact: true });
            if (issue !== 'gone' && issue.state === 'open' && stillLinked()) {
              // The comment is safe to retry if the close fails or the process stops between requests.
              await client.ensureIssueComment(
                owner,
                name,
                number,
                `Discord ticket \`${ticketKey}\` was deleted.`,
              );
              if (stillLinked()) await client.closeIssueNotPlanned(owner, name, number);
            }
          }
          projects.finishIssueClosure(ticketId);
        } catch (e) {
          log.error(
            'github',
            `could not close ${owner}/${name}#${number} for deleted ticket ${ticketKey}`,
            e,
          );
        }
      });
    }
  }

  /** Brings a linked issue in line with its ticket after a change in Discord. Never throws. */
  async pushTicket(project: Project, ticket: Ticket): Promise<void> {
    await this.runIssueWork(ticket.id, async () => {
      const current = this.deps.projects.ticket(ticket.id);
      if (current && !current.deleted) await this.pushCurrentTicket(project, current);
    });
  }

  private async pushCurrentTicket(project: Project, ticket: Ticket): Promise<void> {
    const { client, projects, discord, log } = this.deps;
    const link = ticket.issue;
    if (!link) return;
    const ref = `${link.owner}/${link.name}#${link.number}`;
    try {
      const issue = await client.getIssue(link.owner, link.name, link.number);
      if (issue === 'gone') {
        projects.unlinkIssue(ticket.id);
        await discord.note(
          ticket,
          `${ref} is no longer on GitHub (deleted or moved); this ticket is now local.`,
        );
        return;
      }
      const template = this.deps.templateFor(project);
      const done = Boolean(template.find((s) => s.key === ticket.status)?.done);
      const labels = labelsForStatus(issue.labels, ticket.status, template, this.deps.prefix);
      const assignees = issueAssigneesFor(issue.assignees, ticket.assignees, this.loginOf, (l) =>
        Boolean(this.userOf(l)),
      );
      const change: { title?: string; state?: 'open' | 'closed'; labels?: string[]; assignees?: string[] } =
        {};
      if (issue.title !== ticket.title) change.title = ticket.title;
      if ((issue.state === 'closed') !== done) change.state = done ? 'closed' : 'open';
      if (!sameSet(issue.labels, labels)) change.labels = labels;
      if (!sameSet(issue.assignees, assignees)) change.assignees = assignees;
      if (Object.keys(change).length) await client.updateIssue(link.owner, link.name, link.number, change);
      await this.noteMissingProfiles(ticket, ref);
    } catch (e) {
      log.error('github', `could not update ${ref}`, e);
      await discord.note(ticket, `Could not update GitHub (${ref}): ${(e as Error).message}`).catch(() => {});
    }
  }

  /** An issue returned by GitHub can arrive in a poll before its create response arrives. */
  private async waitForIssueLinks(owner: string, name: string): Promise<void> {
    const repo = `${owner}/${name}`.toLowerCase();
    const pending = [...this.creating.values()].filter((creation) => creation.repo === repo);
    await Promise.allSettled(pending.map((creation) => creation.result));
  }

  /** Creates the issue for a ticket (title, description, status label, assignees) and links it. */
  async createIssueFor(project: Project, ticket: Ticket, owner: string, name: string): Promise<number> {
    const repo = `${owner}/${name}`.toLowerCase();
    const pending = this.creating.get(ticket.id);
    if (pending?.repo === repo) return pending.result;
    if (pending) throw new Error('An issue is already being created for this ticket.');
    const current = this.deps.projects.ticket(ticket.id);
    if (!current || current.deleted) throw new Error('This ticket was deleted.');
    if (current.issue) throw new Error('This ticket is already linked to a GitHub issue.');
    const result = this.createAndLinkIssue(project, current, owner, name).finally(() => {
      this.creating.delete(ticket.id);
    });
    this.creating.set(ticket.id, { repo, result });
    return result;
  }

  private async createAndLinkIssue(
    project: Project,
    ticket: Ticket,
    owner: string,
    name: string,
  ): Promise<number> {
    const { client, projects } = this.deps;
    const labels = labelsForStatus([], ticket.status, this.deps.templateFor(project), this.deps.prefix);
    const assignees = ticket.assignees.map(this.loginOf).filter((l): l is string => Boolean(l));
    const number = await client.createIssue(owner, name, {
      title: ticket.title,
      body: ticket.body,
      labels,
      assignees,
    });
    const result = projects.linkCreatedIssue(ticket.id, owner, name, number);
    if (result === 'queued') {
      throw new Error(
        `Created ${owner}/${name}#${number}, but the ticket was deleted. The issue will be closed on sync.`,
      );
    }
    if (result === 'ignored') {
      const message = `Created ${owner}/${name}#${number}, but its Discord ticket no longer accepts links.`;
      this.deps.log.warn('github', message);
      throw new Error(message);
    }
    const current = projects.ticket(ticket.id)!;
    // Local changes made while GitHub was creating the issue could not be pushed yet.
    if (
      current.title !== ticket.title ||
      current.status !== ticket.status ||
      !sameSet(current.assignees, ticket.assignees)
    ) {
      await this.pushTicket(project, current);
    } else {
      await this.noteMissingProfiles(current, `${owner}/${name}#${number}`);
    }
    return number;
  }

  /** Links a ticket to an existing issue, whose state then wins. Returns an error text, or undefined. */
  async linkExisting(
    project: Project,
    ticket: Ticket,
    ref: { owner: string; name: string; number: number },
  ): Promise<string | undefined> {
    const { client, projects } = this.deps;
    const label = `${ref.owner}/${ref.name}#${ref.number}`;
    const inProject = projects
      .repos(project.id)
      .some(
        (r) =>
          r.owner.toLowerCase() === ref.owner.toLowerCase() &&
          r.name.toLowerCase() === ref.name.toLowerCase(),
      );
    if (!inProject) return `\`${ref.owner}/${ref.name}\` is not a repo of **${project.name}**; add it first.`;
    if (projects.wasLinkedToDeletedTicket(project.id, ref.owner, ref.name, ref.number, true)) {
      return `${label} is waiting to be closed because its Discord ticket was deleted. Try again after sync.`;
    }
    const taken = projects.ticketByIssue(ref.owner, ref.name, ref.number);
    if (taken && taken.id !== ticket.id) return `${label} is already linked to **${taken.key}**.`;
    const issue = await client.getIssue(ref.owner, ref.name, ref.number);
    if (issue === 'gone') return `${label} does not exist (or the app can't see it).`;
    if (this.creating.has(ticket.id)) return 'An issue is already being created for this ticket.';
    if (projects.ticket(ticket.id)?.deleted) return 'This ticket was deleted.';
    if (projects.wasLinkedToDeletedTicket(project.id, ref.owner, ref.name, ref.number, true)) {
      return `${label} is waiting to be closed because its Discord ticket was deleted. Try again after sync.`;
    }
    projects.linkIssue(ticket.id, ref.owner, ref.name, ref.number);
    await this.applyIssue(project, projects.ticket(ticket.id)!, issue, true);
    return undefined;
  }

  /** Applies an issue's title, status and assignees to its ticket. Returns whether anything changed. */
  private async applyIssue(
    project: Project,
    ticket: Ticket,
    issue: GhIssue,
    force = false,
  ): Promise<boolean> {
    const { projects, discord } = this.deps;
    if (!force && withinGrace(projects.lastLocalChangeAt(ticket.id), this.now())) return false;
    const target = stateFromIssue(issue, this.deps.templateFor(project), this.deps.prefix, ticket.status);
    // Not an assignment change: only what the control message shows. Stored first so every redraw
    // below shows it.
    const unlinkedChanged = projects.setUnlinkedGithubLogins(ticket.id, this.unlinkedOf(issue.assignees));
    let current = unlinkedChanged ? (projects.ticket(ticket.id) ?? ticket) : ticket;
    let changed = false;
    if (target.title !== current.title) {
      const updated = projects.setTitle(current.id, target.title, '', 'github');
      if (updated) {
        await discord.applyChange(project, updated, {
          type: 'title',
          from: current.title,
          to: target.title,
          ...FROM_GITHUB,
        });
        current = updated;
        changed = true;
      }
    }
    if (target.status !== current.status) {
      const updated = projects.setStatus(current.id, target.status, '', 'github');
      if (updated) {
        await discord.applyChange(project, updated, {
          type: 'status',
          from: current.status,
          to: target.status,
          ...FROM_GITHUB,
        });
        current = updated;
        changed = true;
      }
    }
    const wanted = ticketAssigneesFor(issue.assignees, current.assignees, this.userOf, this.hasProfile);
    for (const userId of wanted.filter((id) => !current.assignees.includes(id))) {
      if (projects.addAssignee(current.id, userId, '', 'github')) {
        await discord.applyChange(project, projects.ticket(current.id)!, {
          type: 'assigned',
          to: userId,
          ...FROM_GITHUB,
        });
        changed = true;
      }
    }
    for (const userId of current.assignees.filter((id) => !wanted.includes(id))) {
      if (projects.removeAssignee(current.id, userId, '', 'github')) {
        await discord.applyChange(project, projects.ticket(current.id)!, {
          type: 'unassigned',
          from: userId,
          ...FROM_GITHUB,
        });
        changed = true;
      }
    }
    if (unlinkedChanged && !changed) await discord.refresh(project, projects.ticket(current.id) ?? current);
    return changed || unlinkedChanged;
  }

  /** A ticket for an issue: title, description (set once), status from labels, mapped assignees. */
  private async ticketFromIssue(
    project: Project,
    owner: string,
    name: string,
    issue: GhIssue,
    announce: boolean,
  ) {
    const { projects, discord } = this.deps;
    const template = this.deps.templateFor(project);
    const { status } = stateFromIssue(issue, template, this.deps.prefix, template[0]!.key);
    const created = projects.createTicket(
      project.id,
      { title: issue.title, body: issue.body, status, createdBy: '' },
      'github',
    );
    projects.linkIssue(created.id, owner, name, issue.number);
    projects.setUnlinkedGithubLogins(created.id, this.unlinkedOf(issue.assignees));
    for (const userId of ticketAssigneesFor(issue.assignees, [], this.userOf, this.hasProfile)) {
      projects.addAssignee(created.id, userId, '', 'github');
    }
    const ticket = projects.ticket(created.id)!;
    await discord.postTicket(project, ticket);
    if (announce) await discord.applyChange(project, ticket, { type: 'created', to: status, ...FROM_GITHUB });
  }
}

/** The newest `updatedAt` among the issues, or the previous value. */
function newest(issues: GhIssue[], previous: string | null): string | null {
  return issues.reduce<string | null>((max, i) => (!max || i.updatedAt > max ? i.updatedAt : max), previous);
}

function sameSet(a: string[], b: string[]): boolean {
  const norm = (list: string[]) => [...new Set(list.map((x) => x.toLowerCase()))].sort().join('\n');
  return norm(a) === norm(b);
}
