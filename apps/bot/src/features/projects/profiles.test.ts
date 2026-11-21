import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../../db.ts';
import { isValidEmail, isValidGithubLogin, profilesStore } from './profiles.ts';

const tempStore = () => profilesStore(openDatabase(mkdtempSync(join(tmpdir(), 'discord-kit-profiles-'))));

test('validates github usernames', () => {
  for (const ok of ['octocat', 'a', 'a-b', 'A1-b2', 'x'.repeat(39)])
    assert.equal(isValidGithubLogin(ok), true, ok);
  for (const bad of ['', '-x', 'x-', 'x--y', 'a_b', 'a b', 'x'.repeat(40), '@octocat']) {
    assert.equal(isValidGithubLogin(bad), false, bad);
  }
});

test('validates emails loosely', () => {
  assert.equal(isValidEmail('me@example.com'), true);
  assert.equal(isValidEmail('me+dk@sub.example.co'), true);
  for (const bad of ['', 'me', 'me@', 'me@example', 'me @example.com'])
    assert.equal(isValidEmail(bad), false, bad);
});

test('stores, updates and clears a profile', () => {
  const store = tempStore();
  assert.equal(store.profile('u1'), undefined);
  store.setProfile('u1', { githubLogin: 'octocat', email: 'me@example.com' });
  assert.equal(store.profile('u1')?.githubLogin, 'octocat');
  store.setProfile('u1', { githubLogin: 'octocat', email: '' });
  assert.equal(store.profile('u1')?.email, null);
  assert.equal(store.clearProfile('u1'), true);
  assert.equal(store.clearProfile('u1'), false);
  assert.equal(store.profile('u1'), undefined);
});

test('finds a member by github username ignoring case', () => {
  const store = tempStore();
  store.setProfile('u1', { githubLogin: 'OctoCat', email: null });
  assert.equal(store.userByGithubLogin('octocat'), 'u1');
  assert.equal(store.userByGithubLogin('nobody'), undefined);
});

test('refuses a github username another member already uses', () => {
  const store = tempStore();
  store.setProfile('u1', { githubLogin: 'octocat', email: null });
  assert.throws(() => store.setProfile('u2', { githubLogin: 'OCTOCAT', email: null }), /already used/);
  store.setProfile('u1', { githubLogin: 'OctoCat', email: null });
  assert.equal(store.profile('u1')?.githubLogin, 'OctoCat');
});
