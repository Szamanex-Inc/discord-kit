import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { DEFAULT_TEMPLATES } from '@discord-kit/config';
import { boardEmbeds, Debouncer } from './board.ts';
import type { Ticket } from './store.ts';

const dev = DEFAULT_TEMPLATES.dev!;
let n = 0;
const ticket = (status: string, over: Partial<Ticket> = {}): Ticket => {
  n++;
  return {
    id: n,
    projectId: 1,
    number: n,
    key: `DK-${n}`,
    title: `Ticket ${n}`,
    body: '',
    status,
    threadId: null,
    controlMessageId: null,
    deleted: false,
    createdBy: 'u1',
    createdAt: '',
    updatedAt: new Date(2026, 0, 1, 0, n).toISOString(),
    assignees: [],
    issue: null,
    unlinkedGithubLogins: [],
    bodyEdited: false,
    ...over,
  };
};
const text = (e: { embed: { toJSON(): { title?: string; description?: string } } }) => e.embed.toJSON();

test('one embed per status in template order, newest activity first', () => {
  const a = ticket('todo');
  const b = ticket('todo', { assignees: ['u7'] });
  const embeds = boardEmbeds([a, b, ticket('testing')], dev);
  assert.deepEqual(
    embeds.map((e) => e.status),
    dev.map((s) => s.key),
  );
  const todo = text(embeds[0]!);
  assert.equal(todo.title, '🟦 Todo (2)');
  assert.deepEqual(todo.description?.split('\n'), [
    `**${b.key}** ${b.title} · <@u7>`,
    `**${a.key}** ${a.title}`,
  ]);
  assert.equal(text(embeds[1]!).description, 'nothing here');
});

test('truncates long statuses with a pointer to /ticket list', () => {
  const many = Array.from({ length: 20 }, () => ticket('todo'));
  const todo = text(boardEmbeds(many, dev, { maxPerStatus: 15 })[0]!);
  const lines = todo.description!.split('\n');
  assert.equal(lines.length, 16);
  assert.equal(lines.at(-1), '+5 more, use `/ticket list`');
});

test('done statuses show a count and the latest few', () => {
  const done = Array.from({ length: 8 }, () => ticket('deployed'));
  const deployed = text(boardEmbeds(done, dev, { doneShown: 5 }).at(-1)!);
  assert.equal(deployed.title, '🚀 Deployed (8)');
  assert.equal(deployed.description!.split('\n').length, 5);
});

test('tickets with an unknown status get their own embed', () => {
  const embeds = boardEmbeds([ticket('gone')], dev);
  assert.equal(embeds.at(-1)!.status, '?');
  assert.ok(text(embeds.at(-1)!).title!.startsWith('Unknown status'));
});

test('keeps descriptions within 4096 characters', () => {
  const long = Array.from({ length: 200 }, () => ticket('todo', { title: 'y'.repeat(90) }));
  const todo = text(boardEmbeds(long, dev, { maxPerStatus: 200 })[0]!);
  assert.ok(todo.description!.length <= 4096);
  assert.ok(todo.description!.endsWith('use `/ticket list`'));
});

test('debouncer runs once for a burst', async () => {
  const runs: number[] = [];
  const d = new Debouncer(async (key) => void runs.push(key), 10);
  for (let i = 0; i < 5; i++) d.schedule(1);
  d.schedule(2);
  await sleep(40);
  assert.deepEqual(
    runs.sort((a, b) => a - b),
    [1, 2],
  );
  d.stop();
});

test('debouncer runs once more when scheduled during a run', async () => {
  let release!: () => void;
  let calls = 0;
  const d = new Debouncer(async () => {
    calls++;
    if (calls === 1) await new Promise<void>((r) => (release = r));
  }, 5);
  d.schedule(1);
  await sleep(20);
  d.schedule(1);
  d.schedule(1);
  release();
  await sleep(40);
  assert.equal(calls, 2);
  d.stop();
});

test('stopped debouncer runs nothing', async () => {
  let calls = 0;
  const d = new Debouncer(async () => void calls++, 10);
  d.schedule(1);
  d.stop();
  await sleep(30);
  assert.equal(calls, 0);
});
