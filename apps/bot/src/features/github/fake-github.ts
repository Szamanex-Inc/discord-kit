import type { GitHubClient } from './client.ts';
import type { GhIssue } from './sync.ts';

/**
 * An in-memory GitHub for tests: installed repos, labels and issues. `edit` changes an issue the way
 * someone on GitHub would (its updatedAt moves forward); `failWrites` makes writes fail like a 403.
 */
export class FakeGitHub implements GitHubClient {
  readonly installed = new Set<string>();
  readonly labels = new Map<string, string[]>();
  readonly issues = new Map<string, GhIssue[]>();
  readonly comments = new Map<string, Set<string>>();
  readonly notPlanned = new Set<string>();
  readonly writes: string[] = [];
  readonly pulls = new Map<string, FakePull[]>();
  failWrites = false;
  private clock = Date.parse('2026-01-01T00:00:00Z');

  private now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private list(owner: string, repo: string): GhIssue[] {
    const key = `${owner}/${repo}`.toLowerCase();
    if (!this.issues.has(key)) this.issues.set(key, []);
    return this.issues.get(key)!;
  }

  install(repo: string): void {
    this.installed.add(repo.toLowerCase());
  }

  add(repo: string, issue: Partial<GhIssue> & { title: string }): GhIssue {
    const [owner = '', name = ''] = repo.split('/');
    const list = this.list(owner, name);
    const at = this.now();
    const created: GhIssue = {
      number: list.length + 1,
      body: '',
      state: 'open',
      labels: [],
      assignees: [],
      createdAt: at,
      updatedAt: at,
      ...issue,
    };
    list.push(created);
    return created;
  }

  edit(repo: string, number: number, change: Partial<GhIssue>): void {
    const [owner = '', name = ''] = repo.split('/');
    const issue = this.list(owner, name).find((i) => i.number === number)!;
    Object.assign(issue, change, { updatedAt: this.now() });
  }

  issue(repo: string, number: number): GhIssue | undefined {
    const [owner = '', name = ''] = repo.split('/');
    return this.list(owner, name).find((i) => i.number === number);
  }

  async appSlug() {
    return 'szamanex-bot';
  }
  async installationFor(owner: string, repo: string) {
    return this.installed.has(`${owner}/${repo}`.toLowerCase()) ? 1 : undefined;
  }
  async ensureLabels(owner: string, repo: string, labels: { name: string }[]) {
    this.labels.set(
      `${owner}/${repo}`.toLowerCase(),
      labels.map((l) => l.name),
    );
  }
  async countOpenIssues(owner: string, repo: string) {
    return this.list(owner, repo).filter((i) => i.state === 'open').length;
  }
  addPull(repo: string, pull: Partial<FakePull> & { number: number }): FakePull {
    const key = repo.toLowerCase();
    const created: FakePull = {
      title: `PR ${pull.number}`,
      body: '',
      url: `https://github.com/${repo}/pull/${pull.number}`,
      author: 'someone',
      headSha: 'sha1',
      updatedAt: this.now(),
      checkRuns: [],
      statuses: [],
      mergeableState: 'clean',
      reviews: [],
      ...pull,
    };
    this.pulls.set(key, [...(this.pulls.get(key) ?? []), created]);
    return created;
  }

  editPull(repo: string, number: number, change: Partial<FakePull>): void {
    const pull = this.pulls.get(repo.toLowerCase())!.find((p) => p.number === number)!;
    Object.assign(pull, change, { updatedAt: this.now() });
  }

  async listOpenPulls(owner: string, repo: string) {
    return (this.pulls.get(`${owner}/${repo}`.toLowerCase()) ?? []).map(
      ({ number, title, body, url, author, headSha, updatedAt }) => ({
        number,
        title,
        body,
        url,
        author,
        headSha,
        updatedAt,
      }),
    );
  }

  async pullDetails(owner: string, repo: string, pull: { number: number }) {
    const p = this.pulls.get(`${owner}/${repo}`.toLowerCase())!.find((x) => x.number === pull.number)!;
    return {
      checkRuns: p.checkRuns,
      statuses: p.statuses,
      mergeableState: p.mergeableState,
      reviews: p.reviews,
    };
  }

  async userExists() {
    return true;
  }
  async listIssues(owner: string, repo: string, opts: { since?: string; state: 'open' | 'all' }) {
    const issues = this.list(owner, repo)
      .filter((i) => opts.state === 'all' || i.state === 'open')
      .filter((i) => !opts.since || i.updatedAt >= opts.since)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .map((i) => ({ ...i, labels: [...i.labels], assignees: [...i.assignees] }));
    return { notModified: false as const, issues };
  }
  async getIssue(owner: string, repo: string, number: number) {
    const issue = this.list(owner, repo).find((i) => i.number === number);
    return issue ? { ...issue } : ('gone' as const);
  }
  async createIssue(
    owner: string,
    repo: string,
    issue: { title: string; body: string; labels: string[]; assignees: string[] },
  ) {
    if (this.failWrites)
      throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
    this.writes.push(`create ${owner}/${repo}`);
    return this.add(`${owner}/${repo}`, issue).number;
  }
  async updateIssue(
    owner: string,
    repo: string,
    number: number,
    change: { title?: string; state?: 'open' | 'closed'; labels?: string[]; assignees?: string[] },
  ) {
    if (this.failWrites)
      throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
    this.writes.push(`update ${owner}/${repo}#${number} ${Object.keys(change).join(',')}`);
    this.edit(`${owner}/${repo}`, number, change);
  }
  async closeIssueNotPlanned(owner: string, repo: string, number: number) {
    await this.updateIssue(owner, repo, number, { state: 'closed' });
    this.notPlanned.add(`${owner}/${repo}#${number}`);
  }
  async ensureIssueComment(owner: string, repo: string, number: number, body: string) {
    if (this.failWrites) throw new Error('Resource not accessible by integration');
    const ref = `${owner}/${repo}#${number}`;
    const comments = this.comments.get(ref) ?? new Set<string>();
    if (!comments.has(body)) this.writes.push(`comment ${ref}`);
    comments.add(body);
    this.comments.set(ref, comments);
  }
}

/** A pull request in the fake GitHub, with what pullDetails reports for it. */
export type FakePull = import('./client.ts').GhPull & import('./client.ts').GhPullDetails;
