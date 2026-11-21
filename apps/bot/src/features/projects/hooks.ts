import type { Project, Ticket } from './store.ts';

export type RepoCheck = { ok: true; openIssues: number } | { ok: false; reason: string };

/**
 * How the projects module reaches the github feature without depending on it. The github feature
 * fills these in on start and resets them on stop; while it is off, GitHub is simply not involved.
 */
export const githubHooks: {
  /** Whether a GitHub user exists; undefined when GitHub is not connected. */
  loginExists: (login: string) => Promise<boolean | undefined>;
  /** Can this repo be added (app installed, no other project)? Creates the status labels. */
  checkRepo?: (repo: {
    projectId?: number;
    template: string;
    owner: string;
    name: string;
  }) => Promise<RepoCheck>;
  /** A repo was added; returns the id the import choice buttons refer to. */
  repoAdded?: (project: Project, owner: string, name: string) => number;
  repoRemoved?: (project: Project, owner: string, name: string) => void;
  /** A linked ticket changed in Discord: push its state to the issue (fire and forget). */
  ticketChanged?: (project: Project, ticket: Ticket) => void;
  /** Creates the GitHub issue for a ticket and links it; returns the issue number. */
  createIssue?: (project: Project, ticket: Ticket, owner: string, name: string) => Promise<number>;
  /** A member-made forum post became a ticket. Set only when automatic issue creation is enabled. */
  forumTicketCreated?: (project: Project, ticket: Ticket) => Promise<void>;
  /** Links a ticket to an existing issue; returns an error text, or undefined when linked. */
  linkIssue?: (
    project: Project,
    ticket: Ticket,
    ref: { owner: string; name: string; number: number },
  ) => Promise<string | undefined>;
  /** Polls GitHub now for one project, or all of them. */
  sync?: (projectId?: number) => Promise<{ changed: number; created: number }>;
} = {
  loginExists: async () => undefined,
};

/** Back to "GitHub off" (used when the github feature stops). */
export function resetGithubHooks(): void {
  githubHooks.loginExists = async () => undefined;
  delete githubHooks.checkRepo;
  delete githubHooks.repoAdded;
  delete githubHooks.repoRemoved;
  delete githubHooks.ticketChanged;
  delete githubHooks.createIssue;
  delete githubHooks.forumTicketCreated;
  delete githubHooks.linkIssue;
  delete githubHooks.sync;
}
