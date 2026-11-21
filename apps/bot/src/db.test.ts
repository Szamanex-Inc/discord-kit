import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrate, MigrationError, openDatabase, type Migration } from './db.ts';

const tempDb = () => openDatabase(mkdtempSync(join(tmpdir(), 'discord-kit-db-')));

const applied = (db: DatabaseSync) =>
  db
    .prepare('SELECT module, version FROM schema_migrations ORDER BY module, version')
    .all()
    .map((r) => `${String(r.module)}:${Number(r.version)}`);

const tableExists = (db: DatabaseSync, name: string) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

const V1: Migration = { version: 1, sql: 'CREATE TABLE a (x TEXT)' };
const V2: Migration = { version: 2, sql: 'CREATE TABLE b (y TEXT)' };

test('opens in WAL mode', () => {
  const db = tempDb();
  assert.deepEqual({ ...db.prepare('PRAGMA journal_mode').get() }, { journal_mode: 'wal' });
  db.close();
});

test('applies pending migrations once', () => {
  const db = tempDb();
  migrate(db, 'm', [V1, V2]);
  migrate(db, 'm', [V1, V2]);
  assert.ok(tableExists(db, 'a') && tableExists(db, 'b'));
  assert.deepEqual(applied(db), ['m:1', 'm:2']);
  db.close();
});

test('applies only new migrations', () => {
  const db = tempDb();
  migrate(db, 'm', [V1]);
  // V1 has no IF NOT EXISTS, so running it again would throw.
  migrate(db, 'm', [V1, V2]);
  assert.deepEqual(applied(db), ['m:1', 'm:2']);
  db.close();
});

test('keeps modules separate', () => {
  const db = tempDb();
  migrate(db, 'a', [V1, V2]);
  migrate(db, 'b', [{ version: 1, sql: 'CREATE TABLE c (z TEXT)' }]);
  assert.deepEqual(applied(db), ['a:1', 'a:2', 'b:1']);
  db.close();
});

test('rejects gaps in migration numbers', () => {
  const db = tempDb();
  assert.throws(
    () => migrate(db, 'm', [V1, { version: 3, sql: 'SELECT 1' }]),
    (e: unknown) => e instanceof MigrationError && /numbered 1\.\.n/.test(e.message),
  );
  db.close();
});

test('refuses a database from newer code', () => {
  const db = tempDb();
  migrate(db, 'm', [V1, V2]);
  assert.throws(
    () => migrate(db, 'm', [V1]),
    (e: unknown) => e instanceof MigrationError && /has migration 2.*knows up to 1/.test(e.message),
  );
  assert.deepEqual(applied(db), ['m:1', 'm:2']);
  db.close();
});

test('rolls back a failing migration', () => {
  const db = tempDb();
  assert.throws(
    () => migrate(db, 'm', [V1, { version: 2, sql: 'CREATE TABLE c (z TEXT); NOT SQL' }]),
    (e: unknown) => e instanceof MigrationError && /migration 2 failed/.test(e.message),
  );
  assert.equal(tableExists(db, 'c'), false);
  assert.deepEqual(applied(db), ['m:1']);
  migrate(db, 'm', [V1, { version: 2, sql: 'CREATE TABLE c (z TEXT)' }]);
  assert.deepEqual(applied(db), ['m:1', 'm:2']);
  db.close();
});

test('keeps the original error when the rollback itself fails', () => {
  const db = tempDb();
  // The migration commits on its own, so there is no transaction left to roll back.
  assert.throws(
    () => migrate(db, 'm', [{ version: 1, sql: 'CREATE TABLE x (a); COMMIT; NOT SQL' }]),
    (e: unknown) =>
      e instanceof MigrationError && /migration 1 failed/.test(e.message) && !/rollback/i.test(e.message),
  );
  db.close();
});
