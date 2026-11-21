import { App, Octokit } from 'octokit';
import type { GhIssue } from './sync.ts';

/**
 * What the bot needs from GitHub, behind an interface so the logic is tested with a fake. The real
 * implementation authenticates as the GitHub App and uses one installation token per owner.
 */
export interface GitHubClient {
  /** The app's URL name, for install links. */
  appSlug(): Promise<string>;
  /** The installation that can reach a repo, or undefined when the app is not installed there. */
  installationFor(owner: string, repo: string): Promise<number | undefined>;
  /** Creates the labels that do not exist yet (by name, case-insensitive). Never edits or deletes. */
  ensureLabels(owner: string, repo: string, labels: { name: string; color: string }[]): Promise<void>;
  /** Open issues, pull requests excluded. */
  countOpenIssues(owner: string, repo: string): Promise<number>;
  userExists(login: string): Promise<boolean>;
  /**
   * Issues changed since `since` (or all of them), oldest change first, pull requests excluded.
   * With `etag`, answers notModified when nothing changed (such requests do not count against limits).
   */
  listIssues(
    owner: string,
    repo: string,
    opts: { since?: string; state: 'open' | 'all'; etag?: string },
  ): Promise<{ notModified: true } | { notModified: false; etag?: string; issues: GhIssue[] }>;
  /** One issue, or 'gone' when it was deleted or moved to another repo. */
  getIssue(
    owner: string,
    repo: string,
    number: number,
    opts?: { exact?: boolean },
  ): Promise<GhIssue | 'gone'>;
  createIssue(
    owner: string,
    repo: string,
    issue: { title: string; body: string; labels: string[]; assignees: string[] },
  ): Promise<number>;
  updateIssue(
    owner: string,
    repo: string,
    number: number,
    change: { title?: string; state?: 'open' | 'closed'; labels?: string[]; assignees?: string[] },
  ): Promise<void>;
  closeIssueNotPlanned(owner: string, repo: string, number: number): Promise<void>;
  ensureIssueComment(owner: string, repo: string, number: number, body: string): Promise<void>;
  /** Open pull requests. */
  listOpenPulls(owner: string, repo: string): Promise<GhPull[]>;
  /** Check runs and statuses of the head commit, mergeable state and reviews of a pull request. */
  pullDetails(owner: string, repo: string, pull: GhPull): Promise<GhPullDetails>;
}

export interface GhPull {
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  headSha: string;
  updatedAt: string;
}

export interface GhPullDetails {
  checkRuns: { name: string; status: string; conclusion: string | null }[];
  statuses: { context: string; state: string }[];
  /** GitHub's mergeable_state; "dirty" means merge conflicts. */
  mergeableState: string;
  reviews: { user: string; state: string }[];
}

type RawIssue = {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  labels: (string | { name?: string })[];
  assignees?: { login: string }[] | null;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
};

function toIssue(i: RawIssue): GhIssue {
  return {
    number: i.number,
    title: i.title,
    body: i.body ?? '',
    state: i.state === 'closed' ? 'closed' : 'open',
    labels: i.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
    assignees: (i.assignees ?? []).map((a) => a.login),
    createdAt: i.created_at,
    updatedAt: i.updated_at,
  };
}

const status = (e: unknown) => (e as { status?: number }).status;

const REQUEST_TIMEOUT_MS = 10_000;

const GitHubOctokit = Octokit.defaults({
  request: {
    fetch: (...[input, init]: Parameters<typeof fetch>) => {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      return fetch(input, { ...init, signal });
    },
  },
});

export function createGitHubClient(creds: { appId: string; privateKey: string }): GitHubClient {
  const app = new App({ appId: creds.appId, privateKey: creds.privateKey, Octokit: GitHubOctokit });
  // Public data (does a user exist?) needs no installation.
  const anonymous = new GitHubOctokit();
  const installations = new Map<string, number>();
  let slug: string | undefined;

  async function installationFor(owner: string, repo: string): Promise<number | undefined> {
    const key = `${owner}/${repo}`.toLowerCase();
    const cached = installations.get(key);
    if (cached) return cached;
    try {
      const { data } = await app.octokit.request('GET /repos/{owner}/{repo}/installation', { owner, repo });
      installations.set(key, data.id);
      return data.id;
    } catch (e) {
      if (status(e) === 404) return undefined;
      throw e;
    }
  }

  async function repoOctokit(owner: string, repo: string) {
    const id = await installationFor(owner, repo);
    if (!id) throw new Error(`the GitHub App is not installed on ${owner}/${repo}`);
    // octokit caches installation tokens and renews them before they expire.
    return app.getInstallationOctokit(id);
  }

  return {
    async appSlug() {
      if (!slug) {
        const { data } = await app.octokit.request('GET /app');
        slug = data?.slug ?? 'github-app';
      }
      return slug;
    },
    installationFor,
    async ensureLabels(owner, repo, labels) {
      const octokit = await repoOctokit(owner, repo);
      const existing = await octokit.paginate('GET /repos/{owner}/{repo}/labels', {
        owner,
        repo,
        per_page: 100,
      });
      const names = new Set(existing.map((l) => l.name.toLowerCase()));
      for (const label of labels) {
        if (names.has(label.name.toLowerCase())) continue;
        await octokit.request('POST /repos/{owner}/{repo}/labels', {
          owner,
          repo,
          name: label.name,
          color: label.color,
        });
      }
    },
    async countOpenIssues(owner, repo) {
      const octokit = await repoOctokit(owner, repo);
      const { data } = await octokit.request('GET /search/issues', {
        q: `repo:${owner}/${repo} is:issue is:open`,
        per_page: 1,
      });
      return data.total_count;
    },
    async listIssues(owner, repo, opts) {
      const octokit = await repoOctokit(owner, repo);
      const params = {
        owner,
        repo,
        state: opts.state,
        sort: 'updated' as const,
        direction: 'asc' as const,
        per_page: 100,
        ...(opts.since && { since: opts.since }),
      };
      try {
        const first = await octokit.request('GET /repos/{owner}/{repo}/issues', {
          ...params,
          headers: opts.etag ? { 'if-none-match': opts.etag } : {},
        });
        const items: RawIssue[] =
          first.data.length < 100
            ? (first.data as RawIssue[])
            : ((await octokit.paginate('GET /repos/{owner}/{repo}/issues', params)) as RawIssue[]);
        return {
          notModified: false,
          ...(first.headers.etag && { etag: first.headers.etag }),
          issues: items.filter((i) => !i.pull_request).map(toIssue),
        };
      } catch (e) {
        if (status(e) === 304) return { notModified: true };
        throw e;
      }
    },
    async getIssue(owner, repo, number, opts) {
      const octokit = await repoOctokit(owner, repo);
      try {
        const response = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
          owner,
          repo,
          issue_number: number,
          ...(opts?.exact && { request: { redirect: 'manual' } }),
        });
        if (opts?.exact && (response.status !== 200 || response.data.pull_request)) return 'gone';
        return toIssue(response.data as RawIssue);
      } catch (e) {
        if (status(e) === 404 || status(e) === 410) return 'gone';
        throw e;
      }
    },
    async createIssue(owner, repo, issue) {
      const octokit = await repoOctokit(owner, repo);
      const { data } = await octokit.request('POST /repos/{owner}/{repo}/issues', {
        owner,
        repo,
        ...issue,
        request: { retries: 0 },
      });
      return data.number;
    },
    async updateIssue(owner, repo, number, change) {
      const octokit = await repoOctokit(owner, repo);
      await octokit.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
        owner,
        repo,
        issue_number: number,
        ...change,
        ...(change.state === 'closed' && { state_reason: 'completed' as const }),
        ...(change.state === 'open' && { state_reason: 'reopened' as const }),
      });
    },
    async closeIssueNotPlanned(owner, repo, number) {
      const octokit = await repoOctokit(owner, repo);
      await octokit.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
        owner,
        repo,
        issue_number: number,
        state: 'closed',
        state_reason: 'not_planned',
        request: { redirect: 'error' },
      });
    },
    async ensureIssueComment(owner, repo, number, body) {
      const octokit = await repoOctokit(owner, repo);
      const issue = { owner, repo, issue_number: number };
      const comments = octokit.paginate.iterator(octokit.rest.issues.listComments, {
        ...issue,
        per_page: 100,
        request: { redirect: 'error' },
      });
      for await (const { data } of comments) {
        if (data.some((comment) => comment.body === body)) return;
      }
      await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        ...issue,
        body,
        request: { redirect: 'error', retries: 0 },
      });
    },
    async listOpenPulls(owner, repo) {
      const octokit = await repoOctokit(owner, repo);
      const pulls = await octokit.paginate('GET /repos/{owner}/{repo}/pulls', {
        owner,
        repo,
        state: 'open',
        per_page: 100,
      });
      return pulls.map((p) => ({
        number: p.number,
        title: p.title,
        body: p.body ?? '',
        url: p.html_url,
        author: p.user?.login ?? '',
        headSha: p.head.sha,
        updatedAt: p.updated_at,
      }));
    },
    async pullDetails(owner, repo, pull) {
      const octokit = await repoOctokit(owner, repo);
      const [runs, status, details, reviews] = await Promise.all([
        octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
          owner,
          repo,
          ref: pull.headSha,
          per_page: 100,
        }),
        octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/status', { owner, repo, ref: pull.headSha }),
        octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
          owner,
          repo,
          pull_number: pull.number,
        }),
        octokit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
          owner,
          repo,
          pull_number: pull.number,
          per_page: 100,
        }),
      ]);
      return {
        checkRuns: runs.data.check_runs.map((r) => ({
          name: r.name,
          status: r.status,
          conclusion: r.conclusion ?? null,
        })),
        statuses: status.data.statuses.map((s) => ({ context: s.context, state: s.state })),
        mergeableState: details.data.mergeable_state,
        reviews: reviews.map((r) => ({ user: r.user?.login ?? '', state: r.state })),
      };
    },
    async userExists(login) {
      try {
        await anonymous.request('GET /users/{username}', { username: login });
        return true;
      } catch (e) {
        if (status(e) === 404) return false;
        throw e;
      }
    },
  };
}
