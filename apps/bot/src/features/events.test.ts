import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StoredEvent } from './events-store.ts';
import { dueReminders, fillEvent, zonedTime } from './events.ts';

test('reads a wall-clock time in a time zone, across DST', () => {
  // Warsaw is UTC+2 in summer and UTC+1 in winter.
  assert.equal(zonedTime('2026-07-10', '20:00', 'Europe/Warsaw')?.toISOString(), '2026-07-10T18:00:00.000Z');
  assert.equal(zonedTime('2026-12-10', '20:00', 'Europe/Warsaw')?.toISOString(), '2026-12-10T19:00:00.000Z');
  assert.equal(zonedTime('2026-07-10', '20:00', 'UTC')?.toISOString(), '2026-07-10T20:00:00.000Z');
});

test('rejects malformed or impossible dates', () => {
  assert.equal(zonedTime('2026-02-30', '20:00', 'UTC'), undefined);
  assert.equal(zonedTime('10.07.2026', '20:00', 'UTC'), undefined);
  assert.equal(zonedTime('2026-07-10', '25:00', 'UTC'), undefined);
});

const event = (startsAt: string, remindersSent: number[] = []): StoredEvent => ({
  id: 1,
  discordEventId: 'x',
  title: 'Raid',
  startsAt: new Date(startsAt),
  organizerId: 'u',
  remindersSent,
  cancelled: false,
});

test('finds due reminders that were not sent', () => {
  const now = new Date('2026-07-10T17:50:00Z');
  assert.deepEqual(dueReminders(event('2026-07-10T18:00:00Z'), [60, 15], now), [60, 15]);
  assert.deepEqual(dueReminders(event('2026-07-10T18:00:00Z', [60]), [60, 15], now), [15]);
  assert.deepEqual(dueReminders(event('2026-07-10T20:00:00Z'), [60, 15], now), []);
  assert.deepEqual(dueReminders(event('2026-07-10T17:00:00Z'), [60, 15], now), []);
});

test('fills event placeholders and trims an empty ping', () => {
  assert.equal(
    fillEvent('**{title}** {time} {ping}', { title: 'Raid', time: 'now', ping: '' }),
    '**Raid** now',
  );
});
