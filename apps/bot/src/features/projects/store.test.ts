import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../../db.ts';
import { projectsStore, type Project } from './store.ts';

const tempStore = () => projectsStore(openDatabase(mkdtempSync(join(tmpdir(), 'discord-kit-projects-'))));

const demo = (over: Partial<Project> = {}) => ({
  key: 'DK',
  name: 'discord-kit',
  template: 'dev',
  visibility: 'public' as const,
  categoryId: 'cat1',
  forumId: 'forum1',
  boardId: 'board1',
  activityId: 'act1',
  roleId: 'role1',
  createdBy: 'u1',
  ...over,
});

test('creates and finds a project by key ignoring case', () => {
  const store = tempStore();
  const p = store.createProject(demo());
  assert.equal(store.projectByKey('dk')?.id, p.id);
  assert.equal(store.project(p.id)?.name, 'discord-kit');
  assert.deepEqual(store.project(p.id)?.boardMessageIds, {});
  assert.deepEqual(
    store.projects().map((x) => x.key),
    ['DK'],
  );
});

test('finds a project by any of its channels', () => {
  const store = tempStore();
  const p = store.createProject(demo());
  for (const id of ['cat1', 'forum1', 'board1', 'act1']) assert.equal(store.projectByChannel(id)?.id, p.id);
  assert.equal(store.projectByChannel('other'), undefined);
});

test('rejects a duplicate key', () => {
  const store = tempStore();
  store.createProject(demo());
  assert.throws(() => store.createProject(demo({ key: 'dk', categoryId: 'cat2' })));
});

test('stores board message ids', () => {
  const store = tempStore();
  const p = store.createProject(demo());
  store.setBoardMessageIds(p.id, { todo: 'm1', doing: 'm2' });
  assert.deepEqual(store.project(p.id)?.boardMessageIds, { todo: 'm1', doing: 'm2' });
});

test('manages repos with one default', () => {
  const store = tempStore();
  const p = store.createProject(demo());
  store.addRepo(p.id, 'acme', 'web');
  store.addRepo(p.id, 'acme', 'api');
  assert.deepEqual(store.repos(p.id), [
    { owner: 'acme', name: 'web', isDefault: true },
    { owner: 'acme', name: 'api', isDefault: false },
  ]);
  assert.equal(store.setDefaultRepo(p.id, 'acme', 'api'), true);
  assert.deepEqual(
    store
      .repos(p.id)
      .filter((r) => r.isDefault)
      .map((r) => r.name),
    ['api'],
  );
  assert.equal(store.removeRepo(p.id, 'acme', 'nope'), false);
  assert.equal(store.setDefaultRepo(p.id, 'acme', 'nope'), false);
  assert.equal(store.removeRepo(p.id, 'acme', 'web'), true);
});

test('returns the same store for the same database', () => {
  const db = openDatabase(mkdtempSync(join(tmpdir(), 'discord-kit-projects-')));
  assert.equal(projectsStore(db), projectsStore(db));
});
