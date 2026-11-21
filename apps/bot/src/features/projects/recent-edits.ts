const key = (tags: readonly string[], name: string) => `${[...tags].sort().join(',')}|${name}`;

/**
 * Post states (tags and name) the bot applied in the last `ttlMs`. Discord reports the bot's own
 * edits as thread updates, possibly late and out of order (e.g. two quick moves); recognizing them
 * keeps the bot from mistaking them for edits made by hand.
 */
export class RecentEdits {
  private readonly edits = new Map<string, { key: string; until: number }[]>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 30_000,
  ) {}

  record(threadId: string, tags: readonly string[], name: string): void {
    const live = this.live(threadId);
    live.push({ key: key(tags, name), until: this.now() + this.ttlMs });
    this.edits.set(threadId, live);
  }

  isRecent(threadId: string, tags: readonly string[], name: string): boolean {
    const wanted = key(tags, name);
    return this.live(threadId).some((e) => e.key === wanted);
  }

  private live(threadId: string): { key: string; until: number }[] {
    const now = this.now();
    const live = (this.edits.get(threadId) ?? []).filter((e) => e.until > now);
    if (live.length) this.edits.set(threadId, live);
    else this.edits.delete(threadId);
    return live;
  }
}
