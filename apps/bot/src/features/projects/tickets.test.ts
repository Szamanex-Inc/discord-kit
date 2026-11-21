import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ForumChannel } from 'discord.js';
import { DEFAULT_TEMPLATES } from '@discord-kit/config';
import { findStatus } from './ticket-commands.ts';
import { desiredTags } from './tickets.ts';

const dev = DEFAULT_TEMPLATES.dev!;
const forum = {
  availableTags: [
    ...dev.map((s, i) => ({ id: `tag-${s.key}`, name: s.label.toUpperCase(), position: i })),
    { id: 'tag-bug', name: 'bug' },
  ],
} as unknown as ForumChannel;

test('puts the status tag first and keeps tags added by hand', () => {
  assert.deepEqual(desiredTags(forum, dev, 'testing', ['tag-bug', 'tag-todo']), ['tag-testing', 'tag-bug']);
  assert.deepEqual(desiredTags(forum, dev, 'todo', []), ['tag-todo']);
});

test('applies no status tag for an unknown status', () => {
  assert.deepEqual(desiredTags(forum, dev, 'gone', ['tag-bug']), ['tag-bug']);
});

test('finds a status by key or label ignoring case', () => {
  assert.equal(findStatus(dev, 'in_progress')?.key, 'in_progress');
  assert.equal(findStatus(dev, 'ready for MAIN')?.key, 'ready');
  assert.equal(findStatus(dev, ' Blocked ')?.key, 'blocked');
  assert.equal(findStatus(dev, 'nope'), undefined);
});
