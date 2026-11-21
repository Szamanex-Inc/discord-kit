import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { migrate, type Migration } from '../db.ts';

export type ApplicationStatus = 'pending' | 'accepted' | 'rejected';

export interface Application {
  id: number;
  userId: string;
  /** Question label → answer. */
  answers: Record<string, string>;
  status: ApplicationStatus;
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
}

/** Version 1 is the schema from before migrations existed. */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS applications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        answers TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        decided_by TEXT,
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS applications_user ON applications (user_id, status);
    `,
  },
];

/** Applications submitted through the applications module. */
export class ApplicationsStore {
  constructor(private readonly db: DatabaseSync) {
    migrate(db, 'applications', MIGRATIONS);
  }

  createApplication(userId: string, answers: Record<string, string>): Application {
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare('INSERT INTO applications (user_id, answers, created_at) VALUES (?, ?, ?)')
      .run(userId, JSON.stringify(answers), createdAt);
    return { id: Number(result.lastInsertRowid), userId, answers, status: 'pending', createdAt };
  }

  application(id: number): Application | undefined {
    const row = this.db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
    return row ? toApplication(row) : undefined;
  }

  pendingApplication(userId: string): Application | undefined {
    const row = this.db
      .prepare("SELECT * FROM applications WHERE user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1")
      .get(userId);
    return row ? toApplication(row) : undefined;
  }

  /** Marks a pending application as decided. Returns false if it was already decided. */
  decideApplication(id: number, status: Exclude<ApplicationStatus, 'pending'>, by: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE applications SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(status, by, new Date().toISOString(), id);
    return Number(result.changes) === 1;
  }
}

const stores = new WeakMap<DatabaseSync, ApplicationsStore>();

/** The applications store of a database; its migrations run on first use. */
export function applicationsStore(db: DatabaseSync): ApplicationsStore {
  let store = stores.get(db);
  if (!store) stores.set(db, (store = new ApplicationsStore(db)));
  return store;
}

function toApplication(row: Record<string, SQLOutputValue>): Application {
  return {
    id: Number(row.id),
    userId: String(row.user_id),
    answers: JSON.parse(String(row.answers)) as Record<string, string>,
    status: row.status as ApplicationStatus,
    createdAt: String(row.created_at),
    ...(row.decided_by != null && { decidedBy: String(row.decided_by) }),
    ...(row.decided_at != null && { decidedAt: String(row.decided_at) }),
  };
}
