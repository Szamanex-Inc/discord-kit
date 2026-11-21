import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { migrate, type Migration } from '../../db.ts';

/** GitHub's rules: letters, digits and single hyphens, not at the start or end, at most 39 characters. */
export function isValidGithubLogin(login: string): boolean {
  return /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(login);
}

/** A loose check (something@domain.tld); the address is only stored, never mailed. */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export interface Profile {
  userId: string;
  githubLogin: string | null;
  /** Private: only ever shown to its owner. */
  email: string | null;
  updatedAt: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE profiles (
        user_id TEXT PRIMARY KEY,
        github_login TEXT,
        email TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX profiles_github_login ON profiles (github_login COLLATE NOCASE)
        WHERE github_login IS NOT NULL;
    `,
  },
];

/** Members' GitHub usernames (to map assignees and PR authors) and emails (kept for later use). */
export class ProfilesStore {
  constructor(private readonly db: DatabaseSync) {
    migrate(db, 'profiles', MIGRATIONS);
  }

  profile(userId: string): Profile | undefined {
    const row = this.db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId);
    return row ? toProfile(row) : undefined;
  }

  /** Saves a profile; empty values are stored as null. A username used by another member is refused. */
  setProfile(userId: string, p: { githubLogin: string | null; email: string | null }): void {
    const githubLogin = p.githubLogin?.trim() || null;
    const email = p.email?.trim() || null;
    const owner = githubLogin ? this.userByGithubLogin(githubLogin) : undefined;
    if (owner && owner !== userId)
      throw new Error(`The GitHub username ${githubLogin} is already used by another member.`);
    this.db
      .prepare(
        `INSERT INTO profiles (user_id, github_login, email, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET github_login = excluded.github_login, email = excluded.email,
           updated_at = excluded.updated_at`,
      )
      .run(userId, githubLogin, email, new Date().toISOString());
  }

  clearProfile(userId: string): boolean {
    return Number(this.db.prepare('DELETE FROM profiles WHERE user_id = ?').run(userId).changes) === 1;
  }

  /** The Discord user with this GitHub username (case-insensitive). */
  userByGithubLogin(login: string): string | undefined {
    const row = this.db
      .prepare('SELECT user_id FROM profiles WHERE github_login = ? COLLATE NOCASE')
      .get(login);
    return row ? String(row.user_id) : undefined;
  }
}

const stores = new WeakMap<DatabaseSync, ProfilesStore>();

export function profilesStore(db: DatabaseSync): ProfilesStore {
  let store = stores.get(db);
  if (!store) stores.set(db, (store = new ProfilesStore(db)));
  return store;
}

function toProfile(row: Record<string, SQLOutputValue>): Profile {
  return {
    userId: String(row.user_id),
    githubLogin: row.github_login == null ? null : String(row.github_login),
    email: row.email == null ? null : String(row.email),
    updatedAt: String(row.updated_at),
  };
}
