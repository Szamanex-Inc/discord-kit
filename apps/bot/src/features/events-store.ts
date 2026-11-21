import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { migrate, type Migration } from '../db.ts';

export interface StoredEvent {
  id: number;
  discordEventId: string;
  title: string;
  startsAt: Date;
  /** Name of the role pinged on announce and reminders. */
  pingRole?: string;
  organizerId: string;
  /** `remind_before` values already posted, in minutes. */
  remindersSent: number[];
  cancelled: boolean;
}

/** Version 1 is the schema from before migrations existed. */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_event_id TEXT NOT NULL,
        title TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ping_role TEXT,
        organizer_id TEXT NOT NULL,
        reminders_sent TEXT NOT NULL DEFAULT '[]',
        cancelled INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
];

/** Events created with /event and the reminders already posted for them. */
export class EventsStore {
  constructor(private readonly db: DatabaseSync) {
    migrate(db, 'events', MIGRATIONS);
  }

  createEvent(e: Omit<StoredEvent, 'id' | 'remindersSent' | 'cancelled'>): StoredEvent {
    const result = this.db
      .prepare(
        'INSERT INTO events (discord_event_id, title, starts_at, ping_role, organizer_id) VALUES (?, ?, ?, ?, ?)',
      )
      .run(e.discordEventId, e.title, e.startsAt.toISOString(), e.pingRole ?? null, e.organizerId);
    return { ...e, id: Number(result.lastInsertRowid), remindersSent: [], cancelled: false };
  }

  event(id: number): StoredEvent | undefined {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    return row ? toEvent(row) : undefined;
  }

  /** Events that are not cancelled and start after `from`, soonest first. */
  upcomingEvents(from: Date): StoredEvent[] {
    return this.db
      .prepare('SELECT * FROM events WHERE cancelled = 0 AND starts_at > ? ORDER BY starts_at')
      .all(from.toISOString())
      .map(toEvent);
  }

  markReminderSent(id: number, minutes: number): void {
    const e = this.event(id);
    if (!e || e.remindersSent.includes(minutes)) return;
    this.db
      .prepare('UPDATE events SET reminders_sent = ? WHERE id = ?')
      .run(JSON.stringify([...e.remindersSent, minutes]), id);
  }

  cancelEvent(id: number): void {
    this.db.prepare('UPDATE events SET cancelled = 1 WHERE id = ?').run(id);
  }
}

const stores = new WeakMap<DatabaseSync, EventsStore>();

/** The events store of a database; its migrations run on first use. */
export function eventsStore(db: DatabaseSync): EventsStore {
  let store = stores.get(db);
  if (!store) stores.set(db, (store = new EventsStore(db)));
  return store;
}

function toEvent(row: Record<string, SQLOutputValue>): StoredEvent {
  return {
    id: Number(row.id),
    discordEventId: String(row.discord_event_id),
    title: String(row.title),
    startsAt: new Date(String(row.starts_at)),
    ...(row.ping_role != null && { pingRole: String(row.ping_role) }),
    organizerId: String(row.organizer_id),
    remindersSent: JSON.parse(String(row.reminders_sent)) as number[],
    cancelled: row.cancelled === 1,
  };
}
