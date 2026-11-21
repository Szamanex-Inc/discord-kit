import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDatabase } from './db.ts';
import { applicationsStore } from './features/applications-store.ts';
import { eventsStore } from './features/events-store.ts';
import { OverridesStore } from './overrides.ts';

/** The schema the single Store class created before per-module migrations (discord-kit 0.6). */
const SCHEMA_BEFORE_MIGRATIONS = `
  CREATE TABLE IF NOT EXISTS feature_overrides (
    name TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
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
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_event_id TEXT NOT NULL,
    title TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    ping_role TEXT,
    organizer_id TEXT NOT NULL,
    reminders_sent TEXT NOT NULL DEFAULT '[]',
    cancelled INTEGER NOT NULL DEFAULT 0
  );
`;

test('upgrades a database created before migrations without losing data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-kit-upgrade-'));
  const old = new DatabaseSync(join(dir, 'discord-kit.sqlite'));
  old.exec(SCHEMA_BEFORE_MIGRATIONS);
  const now = new Date().toISOString();
  old
    .prepare('INSERT INTO feature_overrides (name, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?)')
    .run('role_picker', 0, 'alice', now);
  old
    .prepare('INSERT INTO applications (user_id, answers, created_at) VALUES (?, ?, ?)')
    .run('42', JSON.stringify({ 'Who are you?': 'Ann' }), now);
  old
    .prepare('INSERT INTO events (discord_event_id, title, starts_at, organizer_id) VALUES (?, ?, ?, ?)')
    .run('d1', 'Raid', new Date(Date.now() + 3_600_000).toISOString(), 'u1');
  old.close();

  const db = openDatabase(dir);
  const override = new OverridesStore(db).overrides().get('role_picker');
  assert.equal(override?.enabled, false);
  assert.equal(override?.updatedBy, 'alice');
  assert.deepEqual(applicationsStore(db).pendingApplication('42')?.answers, { 'Who are you?': 'Ann' });
  assert.deepEqual(
    eventsStore(db)
      .upcomingEvents(new Date())
      .map((e) => e.title),
    ['Raid'],
  );
  const applied = db
    .prepare('SELECT module, version FROM schema_migrations ORDER BY module')
    .all()
    .map((r) => `${String(r.module)}:${Number(r.version)}`);
  assert.deepEqual(applied, ['applications:1', 'core:1', 'events:1']);
  db.close();
});
