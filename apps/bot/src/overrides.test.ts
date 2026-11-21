import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from './db.ts';
import { OverridesStore } from './overrides.ts';

test('stores, updates and clears feature overrides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-kit-store-'));
  const db = openDatabase(dir);
  const store = new OverridesStore(db);
  assert.equal(store.overrides().size, 0);

  store.setOverride('role_picker', false, 'alice');
  assert.equal(store.overrides().get('role_picker')?.enabled, false);

  store.setOverride('role_picker', true, 'bob');
  const o = store.overrides().get('role_picker');
  assert.equal(o?.enabled, true);
  assert.equal(o?.updatedBy, 'bob');
  db.close();

  // Survives a restart.
  const reopenedDb = openDatabase(dir);
  const reopened = new OverridesStore(reopenedDb);
  assert.equal(reopened.overrides().get('role_picker')?.enabled, true);
  reopened.clearOverride('role_picker');
  assert.equal(reopened.overrides().size, 0);
  reopenedDb.close();
});
