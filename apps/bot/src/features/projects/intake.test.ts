import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThreadChannel } from 'discord.js';
import { openDatabase } from '../../db.ts';
import type { FeatureContext } from '../../feature.ts';
import { githubHooks } from './hooks.ts';
import { registerPost, shouldRegisterPost } from './intake.ts';
import { projectsStore } from './store.ts';

const forums = new Set(['forum1']);

test('registers a post made by a member in a project forum', () => {
  assert.equal(shouldRegisterPost({ ownerId: 'u1', parentId: 'forum1' }, 'bot', forums, false), true);
});

test('ignores posts the bot made itself (/ticket new)', () => {
  assert.equal(shouldRegisterPost({ ownerId: 'bot', parentId: 'forum1' }, 'bot', forums, false), false);
});

test('ignores posts outside project forums', () => {
  assert.equal(shouldRegisterPost({ ownerId: 'u1', parentId: 'other' }, 'bot', forums, false), false);
  assert.equal(shouldRegisterPost({ ownerId: 'u1', parentId: null }, 'bot', forums, false), false);
});

test('ignores posts that are already tickets', () => {
  assert.equal(shouldRegisterPost({ ownerId: 'u1', parentId: 'forum1' }, 'bot', forums, true), false);
});

test('retries a failed fetch once, then gives up', async () => {
  const { retryOnce } = await import('./intake.ts');
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls === 1) throw new Error('Unknown Message');
    return 'text';
  };
  assert.equal(await retryOnce(flaky, 1), 'text');
  assert.equal(calls, 2);
  const broken = async (): Promise<string> => {
    throw new Error('Unknown Message');
  };
  assert.equal(await retryOnce(broken, 1), null);
});

test('forum intake creates one attached local ticket before calling the GitHub hook', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-kit-intake-'));
  const db = openDatabase(dir);
  const store = projectsStore(db);
  const project = store.createProject({
    key: 'DK',
    name: 'discord-kit',
    template: 'dev',
    visibility: 'public',
    createdBy: 'member',
    categoryId: 'category',
    forumId: 'forum',
    boardId: 'board',
    activityId: 'activity',
    roleId: 'role',
  });
  const ctx = {
    db,
    guild: { channels: { cache: new Map() } },
    preset: { config: {} },
    log: { warn() {} },
  } as unknown as FeatureContext;
  const thread = {
    id: 'thread',
    name: 'Forum ticket',
    ownerId: 'member',
    appliedTags: [],
    fetchStarterMessage: async () => ({ content: 'First message' }),
    send: async () => ({ id: 'control', pin: async () => {} }),
    edit: async () => {},
  } as unknown as ThreadChannel;
  const previous = githubHooks.forumTicketCreated;
  t.after(() => {
    if (previous) githubHooks.forumTicketCreated = previous;
    else delete githubHooks.forumTicketCreated;
    db.close();
    rmSync(dir, { recursive: true });
  });
  let calls = 0;
  githubHooks.forumTicketCreated = async (target, ticket) => {
    calls++;
    assert.equal(target.id, project.id);
    assert.equal(ticket.threadId, 'thread');
    assert.equal(ticket.controlMessageId, 'control');
    assert.equal(ticket.title, 'Forum ticket');
    assert.equal(ticket.body, 'First message');
    store.linkIssue(ticket.id, 'acme', 'web', 1);
  };

  const [first, second] = await Promise.all([
    registerPost(ctx, project, thread),
    registerPost(ctx, project, thread),
  ]);
  assert.equal(calls, 1);
  assert.equal(first.id, second.id);
  assert.equal(first.issue?.number, 1);
  assert.equal(store.tickets(project.id).length, 1);
  assert.equal((await registerPost(ctx, project, thread)).id, first.id);
  assert.equal(calls, 1);
});
