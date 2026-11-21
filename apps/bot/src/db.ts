import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** One schema change of a module. Versions are numbered 1..n and never edited once released. */
export interface Migration {
  version: number;
  sql: string;
}

export class MigrationError extends Error {}

/**
 * Opens the bot's database (`<dir>/discord-kit.sqlite`). WAL mode lets other processes on the same
 * machine read while the bot writes.
 */
export function openDatabase(dir: string): DatabaseSync {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'discord-kit.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      module TEXT NOT NULL,
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (module, version)
    );
  `);
  return db;
}

/**
 * Brings a module's tables up to date. Each pending migration runs in its own transaction together
 * with its schema_migrations row, so a failure leaves the database at the last good version.
 */
export function migrate(db: DatabaseSync, module: string, migrations: readonly Migration[]): void {
  if (migrations.some((m, i) => m.version !== i + 1)) {
    throw new MigrationError(`${module}: migrations must be numbered 1..n`);
  }
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations WHERE module = ?').get(module);
  const current = Number(row?.v ?? 0);
  if (current > migrations.length) {
    throw new MigrationError(
      `${module}: the database has migration ${current}, this discord-kit knows up to ${migrations.length}. ` +
        'Upgrade discord-kit or restore a backup.',
    );
  }
  const record = db.prepare('INSERT INTO schema_migrations (module, version, applied_at) VALUES (?, ?, ?)');
  for (const m of migrations.slice(current)) {
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      record.run(module, m.version, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      // The rollback can fail when no transaction is left (e.g. the migration committed on its own);
      // the migration's own error is the one worth reporting.
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignored
      }
      throw new MigrationError(`${module}: migration ${m.version} failed: ${(e as Error).message}`, {
        cause: e,
      });
    }
  }
}
