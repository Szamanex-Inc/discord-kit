import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../db.ts';
import { eventsStore } from './events-store.ts';

test('stores events, reminders and cancellation', () => {
  const db = openDatabase(mkdtempSync(join(tmpdir(), 'discord-kit-store-')));
  const store = eventsStore(db);
  const startsAt = new Date(Date.now() + 3_600_000);
  const e = store.createEvent({
    discordEventId: 'd1',
    title: 'Raid',
    startsAt,
    organizerId: 'u1',
    pingRole: 'Ping: PvE',
  });
  assert.equal(store.upcomingEvents(new Date()).length, 1);
  store.markReminderSent(e.id, 60);
  store.markReminderSent(e.id, 60);
  assert.deepEqual(store.event(e.id)?.remindersSent, [60]);
  assert.equal(store.event(e.id)?.startsAt.getTime(), startsAt.getTime());
  store.cancelEvent(e.id);
  assert.equal(store.upcomingEvents(new Date()).length, 0);
  db.close();
});
