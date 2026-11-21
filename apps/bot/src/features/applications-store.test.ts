import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../db.ts';
import { applicationsStore } from './applications-store.ts';

test('stores applications and decides them once', () => {
  const db = openDatabase(mkdtempSync(join(tmpdir(), 'discord-kit-store-')));
  const store = applicationsStore(db);
  const app = store.createApplication('42', { 'Who are you?': 'Ann' });
  assert.equal(store.pendingApplication('42')?.id, app.id);
  assert.deepEqual(store.application(app.id)?.answers, { 'Who are you?': 'Ann' });

  assert.equal(store.decideApplication(app.id, 'accepted', 'mod'), true);
  assert.equal(store.decideApplication(app.id, 'rejected', 'mod2'), false);
  assert.equal(store.application(app.id)?.status, 'accepted');
  assert.equal(store.application(app.id)?.decidedBy, 'mod');
  assert.equal(store.pendingApplication('42'), undefined);
  db.close();
});

test('returns the same store for the same database', () => {
  const db = openDatabase(mkdtempSync(join(tmpdir(), 'discord-kit-store-')));
  assert.equal(applicationsStore(db), applicationsStore(db));
  db.close();
});
