import type { SendableChannels } from 'discord.js';

/** Logging for the bot and its modules. `scope` is the feature name or e.g. `command /event`. */
export interface Logger {
  /** Console only. */
  info(scope: string, message: string): void;
  /** Console, and the log channel when the preset sets `bot.log_channel`. */
  warn(scope: string, message: string, error?: unknown): void;
  /** Console, and the log channel when the preset sets `bot.log_channel`. */
  error(scope: string, message: string, error?: unknown): void;
}

export interface LogEntry {
  level: 'warn' | 'error';
  scope: string;
  message: string;
  error?: unknown;
}

const ICON = { warn: '⚠️', error: '❌' } as const;
const MAX_ERROR_LENGTH = 300;

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const firstLine = text.split('\n')[0] ?? '';
  return firstLine.length > MAX_ERROR_LENGTH ? firstLine.slice(0, MAX_ERROR_LENGTH - 1) + '…' : firstLine;
}

function formatLine(e: LogEntry): string {
  const line = `${ICON[e.level]} **[${e.scope}]** ${e.message}`;
  return e.error === undefined ? line : `${line} — \`${describeError(e.error)}\``;
}

/**
 * Packs log lines into Discord messages of at most `maxLength` characters without splitting a
 * line; a single line longer than that is truncated. `dropped` entries are reported at the end.
 */
export function formatBatch(entries: LogEntry[], dropped: number, maxLength = 1900): string[] {
  const lines = entries.map((e) => {
    const line = formatLine(e);
    return line.length > maxLength ? line.slice(0, maxLength - 1) + '…' : line;
  });
  if (dropped > 0) lines.push(`… ${dropped} more, see the console`);
  const messages: string[] = [];
  let current = '';
  for (const line of lines) {
    if (current && current.length + 1 + line.length > maxLength) {
      messages.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) messages.push(current);
  return messages;
}

/**
 * Logger that writes to the console and posts warnings and errors to a Discord channel in
 * batches: at most `maxPerFlush` entries every `flushMs`, so an error loop cannot flood the channel
 * or hit rate limits. Failures to post are written to the console and never logged back to the
 * channel.
 */
export class BotLogger implements Logger {
  private buffer: LogEntry[] = [];
  private readonly timer: NodeJS.Timeout;
  private readonly channel: () => SendableChannels | undefined;
  private readonly maxPerFlush: number;

  constructor(opts: { channel: () => SendableChannels | undefined; flushMs?: number; maxPerFlush?: number }) {
    this.channel = opts.channel;
    this.maxPerFlush = opts.maxPerFlush ?? 20;
    this.timer = setInterval(() => void this.flush(), opts.flushMs ?? 5000);
    this.timer.unref();
  }

  info(scope: string, message: string): void {
    console.log(`[${scope}] ${message}`);
  }

  warn(scope: string, message: string, error?: unknown): void {
    this.record({ level: 'warn', scope, message, ...(error !== undefined && { error }) });
  }

  error(scope: string, message: string, error?: unknown): void {
    this.record({ level: 'error', scope, message, ...(error !== undefined && { error }) });
  }

  private flushing: Promise<void> | undefined;

  /** Posts the buffered entries now. Never throws. A call during a flush in progress joins it. */
  flush(): Promise<void> {
    this.flushing ??= this.post().finally(() => (this.flushing = undefined));
    return this.flushing;
  }

  private async post(): Promise<void> {
    if (!this.buffer.length) return;
    const entries = this.buffer.splice(0);
    const shown = entries.slice(0, this.maxPerFlush);
    try {
      const channel = this.channel();
      if (!channel) return;
      for (const content of formatBatch(shown, entries.length - shown.length)) {
        await channel.send({ content, allowedMentions: { parse: [] } });
      }
    } catch (e) {
      console.error('[log] could not post to the log channel:', describeError(e));
    }
  }

  /** Stops the timer and posts what is left. */
  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flushing;
    await this.flush();
  }

  private record(entry: LogEntry): void {
    const line = `[${entry.scope}] ${entry.message}`;
    if (entry.level === 'warn') console.warn(line, ...(entry.error === undefined ? [] : [entry.error]));
    else console.error(line, ...(entry.error === undefined ? [] : [entry.error]));
    this.buffer.push(entry);
  }
}
