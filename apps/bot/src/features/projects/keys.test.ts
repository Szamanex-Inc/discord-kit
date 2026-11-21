import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveKey, isValidKey, parseRepos, roleName } from './keys.ts';

test('derives a key from the project name', () => {
  assert.equal(deriveKey('discord-kit'), 'DK');
  assert.equal(deriveKey('Murmur'), 'MUR');
  assert.equal(deriveKey('ai lore video generator'), 'ALVG');
  assert.equal(deriveKey('next_js render advisor'), 'NJRA');
  assert.equal(deriveKey('one two three four five six seven'), 'OTTFFS');
});

test('a one-letter name gives a key that needs replacing', () => {
  assert.equal(deriveKey('x'), 'X');
  assert.equal(isValidKey('X'), false);
});

test('validates keys', () => {
  assert.equal(isValidKey('DK'), true);
  assert.equal(isValidKey('ABCDEF'), true);
  assert.equal(isValidKey('ABCDEFG'), false);
  assert.equal(isValidKey('dk'), false);
  assert.equal(isValidKey('D1'), false);
});

test('parses repos and removes duplicates', () => {
  assert.deepEqual(parseRepos('acme/web, acme/api acme/api'), [
    { owner: 'acme', name: 'web' },
    { owner: 'acme', name: 'api' },
  ]);
  assert.deepEqual(parseRepos('  '), []);
});

test('rejects a repo that is not owner/name', () => {
  assert.throws(() => parseRepos('acme/web nope'), /'nope'/);
  assert.throws(() => parseRepos('a/b/c'), /'a\/b\/c'/);
});

test('fills the role name format', () => {
  assert.equal(roleName('Project: {name}', 'demo'), 'Project: demo');
});

test('accepts a pasted option name and GitHub URLs', () => {
  const acme = [{ owner: 'acme', name: 'web' }];
  assert.deepEqual(parseRepos('repo:acme/web'), acme);
  assert.deepEqual(parseRepos('repo: acme/web'), acme);
  assert.deepEqual(parseRepos('https://github.com/acme/web'), acme);
  assert.deepEqual(parseRepos('https://github.com/acme/web.git'), acme);
  assert.deepEqual(parseRepos('github.com/acme/web/'), acme);
  assert.deepEqual(parseRepos('git@github.com:acme/web.git'), acme);
});

test('says how to type a repo when it cannot read one', () => {
  assert.throws(() => parseRepos('nope'), /type only owner\/name, e\.g\. acme\/web/);
});
