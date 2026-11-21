import type { DatabaseSync } from 'node:sqlite';
import type { FeatureName } from '@discord-kit/config';
import { migrate, type Migration } from './db.ts';

export interface FeatureOverride {
  name: FeatureName;
  enabled: boolean;
  updatedBy: string;
  updatedAt: string;
}

/** Migrations of the bot core. Version 1 is the schema from before migrations existed. */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS feature_overrides (
        name TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
];

/** Runtime feature overrides set with /feature. */
export class OverridesStore {
  constructor(private readonly db: DatabaseSync) {
    migrate(db, 'core', MIGRATIONS);
  }

  overrides(): Map<FeatureName, FeatureOverride> {
    const rows = this.db.prepare('SELECT name, enabled, updated_by, updated_at FROM feature_overrides').all();
    return new Map(
      rows.map((r) => [
        r.name as FeatureName,
        {
          name: r.name as FeatureName,
          enabled: r.enabled === 1,
          updatedBy: String(r.updated_by),
          updatedAt: String(r.updated_at),
        },
      ]),
    );
  }

  setOverride(name: FeatureName, enabled: boolean, updatedBy: string): void {
    this.db
      .prepare(
        `INSERT INTO feature_overrides (name, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(name, enabled ? 1 : 0, updatedBy, new Date().toISOString());
  }

  clearOverride(name: FeatureName): void {
    this.db.prepare('DELETE FROM feature_overrides WHERE name = ?').run(name);
  }
}
