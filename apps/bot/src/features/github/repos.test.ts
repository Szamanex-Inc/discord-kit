import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_TEMPLATES } from '@discord-kit/config';
import { openDatabase } from '../../db.ts';
import { projectsStore } from '../projects/store.ts';
import type { GitHubClient } from './client.ts';
import { checkRepo } from './repos.ts';

const dev = DEFAULT_TEMPLATES.dev!;

/** A GitHub stand-in: `installed` lists owner/name pairs the app can reach. */
function fakeClient(installed: string[], openIssues = 3) {
  const labelsEnsured: { repo: string; names: string[] }[] = [];
  const client: GitHubClient = {
    appSlug: async () => 'szamanex-bot',
    installationFor: async (owner, repo) => (installed.includes(`${owner}/${repo}`) ? 42 : undefined),
    ensureLabels: async (owner, repo, labels) =>
      void labelsEnsured.push({ repo: `${owner}/${repo}`, names: labels.map((l) => l.name) }),
    countOpenIssues: async () => openIssues,
    userExists: async () => true,
    listIssues: async () => ({ notModified: true }),
    getIssue: async () => 'gone',
    createIssue: async () => 1,
    updateIssue: async () => {},
    closeIssueNotPlanned: async () => {},
    ensureIssueComment: async () => {},
    listOpenPulls: async () => [],
    pullDetails: async () => ({ checkRuns: [], statuses: [], mergeableState: 'clean', reviews: [] }),
  };
  return { client, labelsEnsured };
}

function setup() {
  const store = projectsStore(openDatabase(mkdtempSync(join(tmpdir(), 'discord-kit-gh-'))));
  const channels = { categoryId: 'c', forumId: 'f', boardId: 'b', activityId: 'a', roleId: 'r' };
  const dk = store.createProject({
    key: 'DK',
    name: 'discord-kit',
    template: 'dev',
    visibility: 'public',
    createdBy: 'u',
    ...channels,
  });
  const mur = store.createProject({
    key: 'MUR',
    name: 'murmur',
    template: 'dev',
    visibility: 'public',
    createdBy: 'u',
    ...channels,
    categoryId: 'c2',
  });
  return { store, dk, mur };
}

test('an installed repo gets the status labels and reports its open issues', async () => {
  const { store, dk } = setup();
  const { client, labelsEnsured } = fakeClient(['acme/web'], 37);
  assert.deepEqual(await checkRepo(client, store, dk.id, 'acme', 'web', dev, 'status: '), {
    ok: true,
    openIssues: 37,
  });
  assert.deepEqual(labelsEnsured, [{ repo: 'acme/web', names: dev.map((s) => `status: ${s.label}`) }]);
});

test('a repo without the app installed is refused with the install link', async () => {
  const { store, dk } = setup();
  const { client, labelsEnsured } = fakeClient([]);
  const result = await checkRepo(client, store, dk.id, 'acme', 'web', dev, 'status: ');
  assert.equal(result.ok, false);
  assert.match(
    result.ok ? '' : result.reason,
    /https:\/\/github\.com\/apps\/szamanex-bot\/installations\/new/,
  );
  assert.deepEqual(labelsEnsured, []);
});

test('a repo of another project is refused, naming that project', async () => {
  const { store, dk, mur } = setup();
  store.addRepo(mur.id, 'acme', 'web');
  const { client, labelsEnsured } = fakeClient(['acme/web']);
  const result = await checkRepo(client, store, dk.id, 'ACME', 'Web', dev, 'status: ');
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /murmur/);
  assert.deepEqual(labelsEnsured, []);
});

test('finds the project of a repo ignoring case', () => {
  const { store, mur } = setup();
  store.addRepo(mur.id, 'acme', 'web');
  assert.equal(store.projectByRepo('Acme', 'WEB')?.id, mur.id);
  assert.equal(store.projectByRepo('acme', 'api'), undefined);
});
