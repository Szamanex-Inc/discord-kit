import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Channels and roles the bot created at runtime (projects), which presets do not list. */
export interface ManagedIds {
  channelIds: Set<string>;
  roleIds: Set<string>;
}

/**
 * Reads the ids of bot-managed project channels and roles from the bot's database in `dataDir`,
 * read-only. Undefined when there is no database or it has no projects table.
 */
export function managedIds(dataDir: string): ManagedIds | undefined {
  const path = join(dataDir, 'discord-kit.sqlite');
  if (!existsSync(path)) return undefined;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
      .get();
    if (!hasTable) return undefined;
    const rows = db
      .prepare('SELECT category_id, forum_id, board_id, activity_id, role_id FROM projects')
      .all();
    return {
      channelIds: new Set(
        rows.flatMap((r) => [r.category_id, r.forum_id, r.board_id, r.activity_id].map(String)),
      ),
      roleIds: new Set(rows.map((r) => String(r.role_id))),
    };
  } finally {
    db.close();
  }
}
