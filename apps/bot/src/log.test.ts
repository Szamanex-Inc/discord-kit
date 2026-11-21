import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SendableChannels } from 'discord.js';
import { BotLogger, formatBatch, type LogEntry } from './log.ts';

/** A channel stand-in that records what the logger sends. */
function fakeChannel(send: (payload: unknown) => Promise<unknown> = async () => undefined) {
  const sent: { content: string; allowedMentions: unknown }[] = [];
  const channel = {
    send: (payload: { content: string; allowedMentions: unknown }) => {
      sent.push(payload);
      return send(payload);
    },
  } as unknown as SendableChannels;
  return { channel, sent };
}

// Keep the test output readable: the logger also writes every warning and error to the console.
const quiet = () => {
  const original = console.error;
  console.error = () => {};
  return () => (console.error = original);
};

test('formatBatch formats levels and errors', () => {
  const entries: LogEntry[] = [
    { level: 'warn', scope: 'events', message: 'tick slow' },
    { level: 'error', scope: 'welcome', message: 'dm failed', error: new Error('boom\nstack line') },
  ];
  const [message, ...rest] = formatBatch(entries, 0);
  assert.equal(rest.length, 0);
  assert.ok(message!.includes('⚠️ **[events]** tick slow'));
  assert.ok(message!.includes('❌ **[welcome]** dm failed — `boom`'));
  assert.ok(!message!.includes('stack line'));
});

test('formatBatch splits at maxLength without breaking lines', () => {
  const entries: LogEntry[] = Array.from({ length: 30 }, (_, i) => ({
    level: 'error',
    scope: 'x',
    message: String(i).padEnd(100, '.'),
  }));
  const messages = formatBatch(entries, 0, 1000);
  assert.ok(messages.length > 1);
  assert.ok(messages.every((m) => m.length <= 1000));
  assert.equal(messages.flatMap((m) => m.split('\n')).length, 30);
});

test('formatBatch truncates a single over-long line', () => {
  const [message] = formatBatch([{ level: 'error', scope: 'x', message: 'y'.repeat(3000) }], 0, 1000);
  assert.ok(message!.length <= 1000);
  assert.ok(message!.endsWith('…'));
});

test('formatBatch reports dropped entries', () => {
  const messages = formatBatch([{ level: 'warn', scope: 'x', message: 'm' }], 5);
  assert.ok(messages.at(-1)!.endsWith('… 5 more, see the console'));
});

test('caps entries per flush and never pings', async () => {
  const restore = quiet();
  const { channel, sent } = fakeChannel();
  const log = new BotLogger({ channel: () => channel, maxPerFlush: 20 });
  for (let i = 0; i < 500; i++) log.error('flood', `error ${i}`);
  await log.flush();
  await log.close();
  restore();
  const lines = sent.flatMap((p) => p.content.split('\n'));
  assert.equal(lines.length, 21);
  assert.equal(lines.at(-1), '… 480 more, see the console');
  assert.ok(sent.every((p) => JSON.stringify(p.allowedMentions) === JSON.stringify({ parse: [] })));
});

test('info goes to the console only', async () => {
  const { channel, sent } = fakeChannel();
  const original = console.log;
  console.log = () => {};
  const log = new BotLogger({ channel: () => channel });
  log.info('core', 'started');
  await log.flush();
  await log.close();
  console.log = original;
  assert.equal(sent.length, 0);
});

test('survives a missing channel', async () => {
  const restore = quiet();
  const log = new BotLogger({ channel: () => undefined });
  log.error('x', 'no channel');
  await log.flush();
  await log.close();
  restore();
});

test('does not loop on a failing channel', async () => {
  const restore = quiet();
  const { channel, sent } = fakeChannel(() => Promise.reject(new Error('Missing Permissions')));
  const log = new BotLogger({ channel: () => channel });
  log.error('x', 'first');
  await log.flush();
  await log.flush();
  await log.close();
  restore();
  assert.equal(sent.length, 1);
});

test('survives a channel resolver that throws', async () => {
  const restore = quiet();
  const log = new BotLogger({
    channel: () => {
      throw new Error('not ready');
    },
  });
  log.error('x', 'early error');
  await log.flush();
  await log.close();
  restore();
});

test('never runs two flushes at once', async () => {
  const restore = quiet();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { channel, sent } = fakeChannel(() => gate);
  const log = new BotLogger({ channel: () => channel, maxPerFlush: 20 });
  for (let i = 0; i < 30; i++) log.error('x', `e${i}`);
  const first = log.flush();
  log.error('x', 'during the first flush');
  const second = log.flush();
  assert.equal(sent.length, 1);
  release();
  await Promise.all([first, second]);
  await log.close();
  restore();
  // The entry logged during the first flush is posted afterwards, in its own batch.
  assert.ok(sent.at(-1)!.content.includes('during the first flush'));
  assert.ok(sent.every((p) => p.content.split('\n').length <= 21));
});
