import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TEMPLATES } from '@discord-kit/config';
import {
  decideStartup,
  decideTagEdit,
  decideTitleEdit,
  missingTags,
  needsControlCheck,
} from './reconcile.ts';

const tags = new Map([
  ['t-todo', 'todo'],
  ['t-testing', 'testing'],
  ['t-ready', 'ready'],
]);

test('adopts a single status tag set by hand', () => {
  assert.deepEqual(decideTagEdit(['t-testing'], tags, 'todo'), { action: 'adopt', status: 'testing' });
});

test('does nothing when the status tag matches', () => {
  assert.deepEqual(decideTagEdit(['t-todo', 'bug'], tags, 'todo'), { action: 'none' });
});

test('restores the status when all status tags were removed', () => {
  assert.deepEqual(decideTagEdit(['bug'], tags, 'todo'), { action: 'restore' });
  assert.deepEqual(decideTagEdit([], tags, 'todo'), { action: 'restore' });
});

// Discord saves each tick of the tag picker at once, so a switch passes through "old + new".
test('adopts the new status while the old tag is still there', () => {
  assert.deepEqual(decideTagEdit(['t-todo', 't-testing'], tags, 'todo'), {
    action: 'adopt',
    status: 'testing',
  });
  assert.deepEqual(decideTagEdit(['t-testing', 't-todo', 'bug'], tags, 'todo'), {
    action: 'adopt',
    status: 'testing',
  });
});

test('restores when two new statuses are picked at once', () => {
  assert.deepEqual(decideTagEdit(['t-testing', 't-ready'], tags, 'todo'), { action: 'restore' });
  assert.deepEqual(decideTagEdit(['t-todo', 't-testing', 't-ready'], tags, 'todo'), { action: 'restore' });
});

test('at startup, a post with the old and a new status tag moves to the new one', () => {
  const post = { appliedTagIds: ['t-todo', 't-testing'], name: 'DK-12 · Fix it', archived: false };
  assert.deepEqual(decideStartup({ status: 'todo', title: 'Fix it' }, post, tags, 'DK-12'), {
    status: 'testing',
  });
});

test('ignores non-status tags when deciding', () => {
  assert.deepEqual(decideTagEdit(['bug', 't-testing', 'ui'], tags, 'todo'), {
    action: 'adopt',
    status: 'testing',
  });
});

test('adopts a renamed title and keeps the key', () => {
  assert.deepEqual(decideTitleEdit('DK-12 · Fix it properly', 'DK-12', 'Fix it'), {
    title: 'Fix it properly',
  });
  assert.deepEqual(decideTitleEdit('Fix it properly', 'DK-12', 'Fix it'), {
    title: 'Fix it properly',
    rename: 'DK-12 · Fix it properly',
  });
});

test('only puts the key back when just the prefix was removed', () => {
  assert.deepEqual(decideTitleEdit('Fix it', 'DK-12', 'Fix it'), { rename: 'DK-12 · Fix it' });
  assert.deepEqual(decideTitleEdit('DK-12 · Fix it', 'DK-12', 'Fix it'), {});
});

test('keeps the stored title when the name is only the key', () => {
  assert.deepEqual(decideTitleEdit('DK-12', 'DK-12', 'Fix it'), { rename: 'DK-12 · Fix it' });
});

test('at startup, Discord wins for status and title', () => {
  const post = { appliedTagIds: ['t-testing'], name: 'DK-12 · Renamed', archived: false };
  assert.deepEqual(decideStartup({ status: 'todo', title: 'Fix it' }, post, tags, 'DK-12'), {
    status: 'testing',
    title: 'Renamed',
  });
});

test('at startup, broken status tags are fixed and archived posts reopened only for that', () => {
  const broken = { appliedTagIds: [], name: 'DK-12 · Fix it', archived: true };
  assert.deepEqual(decideStartup({ status: 'todo', title: 'Fix it' }, broken, tags, 'DK-12'), {
    fixTags: true,
    unarchive: true,
  });
  const fine = { appliedTagIds: ['t-todo'], name: 'DK-12 · Fix it', archived: true };
  assert.deepEqual(decideStartup({ status: 'todo', title: 'Fix it' }, fine, tags, 'DK-12'), {});
});

test('lists template statuses without a forum tag', () => {
  const dev = DEFAULT_TEMPLATES.dev!;
  const forumTags = dev
    .filter((s) => s.key !== 'testing')
    .map((s, i) => ({ id: String(i), name: s.label.toLowerCase() }));
  assert.deepEqual(
    missingTags(dev, forumTags).map((s) => s.key),
    ['testing'],
  );
});

test('the quick startup check skips controls of archived done tickets', () => {
  assert.equal(needsControlCheck({ archived: true, done: true, thorough: false }), false);
  assert.equal(needsControlCheck({ archived: true, done: false, thorough: false }), true);
  assert.equal(needsControlCheck({ archived: false, done: true, thorough: false }), true);
  assert.equal(needsControlCheck({ archived: true, done: true, thorough: true }), true);
});
