import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { migrate, type Migration } from '../../db.ts';
import type { PrMemory } from './alerts.ts';

export interface GithubRepo {
  id: number;
  projectId: number;
  owner: string;
  name: string;
  /** Issues created from this moment on become tickets; null until the import choice is made. */
  syncFrom: string | null;
  lastPollAt: string | null;
  /** The newest issue update seen; the next poll asks for changes since then. */
  since: string | null;
  etag: string | null;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE github_repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        owner TEXT NOT NULL COLLATE NOCASE,
        name TEXT NOT NULL COLLATE NOCASE,
        sync_from TEXT,
        last_poll_at TEXT,
        etag TEXT,
        UNIQUE (project_id, owner, name)
      );
    `,
  },
  {
    version: 2,
    // The newest issue update seen so far, used as `since` for the next poll.
    sql: `ALTER TABLE github_repos ADD COLUMN since TEXT;`,
  },
  {
    version: 3,
    // What the bot remembers about each open pull request, to alert only on changes.
    sql: `
      CREATE TABLE pull_requests (
        repo_id INTEGER NOT NULL,
        number INTEGER NOT NULL,
        memory TEXT NOT NULL,
        PRIMARY KEY (repo_id, number)
      );
    `,
  },
  {
    version: 4,
    // Members already told on a ticket that they need a GitHub username to be synced.
    sql: `
      CREATE TABLE profile_notes (
        ticket_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY (ticket_id, user_id)
      );
    `,
  },
];

/** Sync state of each linked repo (the github feature's own tables). */
export class GithubStore {
  constructor(private readonly db: DatabaseSync) {
    migrate(db, 'github', MIGRATIONS);
  }

  /** Registers a linked repo (or returns the existing row) and returns its id. */
  addRepo(projectId: number, owner: string, name: string): number {
    this.db
      .prepare('INSERT OR IGNORE INTO github_repos (project_id, owner, name) VALUES (?, ?, ?)')
      .run(projectId, owner, name);
    const row = this.db
      .prepare('SELECT id FROM github_repos WHERE project_id = ? AND owner = ? AND name = ?')
      .get(projectId, owner, name);
    return Number(row!.id);
  }

  repo(id: number): GithubRepo | undefined {
    const row = this.db.prepare('SELECT * FROM github_repos WHERE id = ?').get(id);
    return row ? toRepo(row) : undefined;
  }

  repos(): GithubRepo[] {
    return this.db.prepare('SELECT * FROM github_repos ORDER BY id').all().map(toRepo);
  }

  setSyncFrom(id: number, syncFrom: string): void {
    this.db.prepare('UPDATE github_repos SET sync_from = ? WHERE id = ?').run(syncFrom, id);
  }

  setPollState(id: number, state: { lastPollAt: string; since: string | null; etag: string | null }): void {
    this.db
      .prepare('UPDATE github_repos SET last_poll_at = ?, since = ?, etag = ? WHERE id = ?')
      .run(state.lastPollAt, state.since, state.etag, id);
  }

  repoByName(projectId: number, owner: string, name: string): GithubRepo | undefined {
    const row = this.db
      .prepare('SELECT * FROM github_repos WHERE project_id = ? AND owner = ? AND name = ?')
      .get(projectId, owner, name);
    return row ? toRepo(row) : undefined;
  }

  prMemory(repoId: number, number: number): (PrMemory & { updatedAt?: string }) | undefined {
    const row = this.db
      .prepare('SELECT memory FROM pull_requests WHERE repo_id = ? AND number = ?')
      .get(repoId, number);
    return row ? (JSON.parse(String(row.memory)) as PrMemory & { updatedAt?: string }) : undefined;
  }

  setPrMemory(repoId: number, number: number, memory: PrMemory & { updatedAt?: string }): void {
    this.db
      .prepare(
        `INSERT INTO pull_requests (repo_id, number, memory) VALUES (?, ?, ?)
         ON CONFLICT(repo_id, number) DO UPDATE SET memory = excluded.memory`,
      )
      .run(repoId, number, JSON.stringify(memory));
  }

  /** Records that a member was told about `/profile edit` on a ticket; false if they already were. */
  markProfileNoted(ticketId: number, userId: string): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO profile_notes (ticket_id, user_id) VALUES (?, ?)')
      .run(ticketId, userId);
    return Number(result.changes) === 1;
  }

  removeRepo(projectId: number, owner: string, name: string): void {
    this.db
      .prepare('DELETE FROM github_repos WHERE project_id = ? AND owner = ? AND name = ?')
      .run(projectId, owner, name);
  }
}

const stores = new WeakMap<DatabaseSync, GithubStore>();

export function githubStore(db: DatabaseSync): GithubStore {
  let store = stores.get(db);
  if (!store) stores.set(db, (store = new GithubStore(db)));
  return store;
}

function toRepo(row: Record<string, SQLOutputValue>): GithubRepo {
  const text = (v: SQLOutputValue | undefined) => (v == null ? null : String(v));
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    owner: String(row.owner),
    name: String(row.name),
    syncFrom: text(row.sync_from),
    lastPollAt: text(row.last_poll_at),
    since: text(row.since),
    etag: text(row.etag),
  };
}
