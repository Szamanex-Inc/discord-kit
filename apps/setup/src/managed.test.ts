import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { managedIds } from './managed.ts';

const tempDir = () => mkdtempSync(join(tmpdir(), 'discord-kit-managed-'));

test('reads the channels and roles of projects from the bot database', () => {
  const dir = tempDir();
  const db = new DatabaseSync(join(dir, 'discord-kit.sqlite'));
  db.exec(`CREATE TABLE projects (category_id TEXT, forum_id TEXT, board_id TEXT, activity_id TEXT, role_id TEXT);
    INSERT INTO projects VALUES ('c1', 'f1', 'b1', 'a1', 'r1');`);
  db.close();
  const ids = managedIds(dir);
  assert.deepEqual([...(ids?.channelIds ?? [])].sort(), ['a1', 'b1', 'c1', 'f1']);
  assert.deepEqual([...(ids?.roleIds ?? [])], ['r1']);
});

test('returns undefined without a database', () => {
  assert.equal(managedIds(tempDir()), undefined);
});

test('returns undefined for a database without projects', () => {
  const dir = tempDir();
  new DatabaseSync(join(dir, 'discord-kit.sqlite')).close();
  assert.equal(managedIds(dir), undefined);
});
