import { EmbedBuilder } from 'discord.js';
import type { StatusSpec } from '@discord-kit/config';
import type { Project, ProjectRepo, Ticket } from './store.ts';

const MAX_DESCRIPTION = 4096;
const UNKNOWN = '?';

const ticketLine = (t: Ticket, withStatus = false) =>
  `**${t.key}** ${t.title}` +
  (withStatus ? ` · \`${t.status}\`` : '') +
  (t.assignees.length ? ` · ${t.assignees.map((id) => `<@${id}>`).join(', ')}` : '');

/** Lines plus a "+N more" pointer, dropping lines until the text fits in an embed description. */
function describe(lines: string[], shown: number, total: number): string {
  if (!total) return 'nothing here';
  for (let n = Math.min(shown, lines.length); n >= 0; n--) {
    const more = total > n ? [`+${total - n} more, use \`/ticket list\``] : [];
    const text = [...lines.slice(0, n), ...more].join('\n');
    if (text.length <= MAX_DESCRIPTION) return text;
  }
  return `${total} tickets, use \`/ticket list\``;
}

/**
 * The project board: one embed per status in template order, tickets with the most recent activity
 * first. Busy statuses are cut after `maxPerStatus`; done statuses show their count and only the
 * latest `doneShown`. Tickets whose status left the template get a final "Unknown status" embed.
 */
export function boardEmbeds(
  tickets: Ticket[],
  template: StatusSpec[],
  opts: { maxPerStatus?: number; doneShown?: number } = {},
): { status: string; embed: EmbedBuilder }[] {
  const maxPerStatus = opts.maxPerStatus ?? 15;
  const doneShown = opts.doneShown ?? 5;
  const newestFirst = [...tickets].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const out = template.map((s) => {
    const list = newestFirst.filter((t) => t.status === s.key);
    const lines = list.map((t) => ticketLine(t));
    const description = s.done
      ? describe(lines, doneShown, Math.min(list.length, doneShown))
      : describe(lines, maxPerStatus, list.length);
    const title = `${s.emoji ? `${s.emoji} ` : ''}${s.label} (${list.length})`;
    return { status: s.key, embed: new EmbedBuilder().setTitle(title).setDescription(description) };
  });
  const known = new Set(template.map((s) => s.key));
  const unknown = newestFirst.filter((t) => !known.has(t.status));
  if (unknown.length) {
    const lines = unknown.map((t) => ticketLine(t, true));
    out.push({
      status: UNKNOWN,
      embed: new EmbedBuilder()
        .setTitle(`Unknown status (${unknown.length})`)
        .setDescription(describe(lines, maxPerStatus, unknown.length)),
    });
  }
  return out;
}

/**
 * Runs `run(key)` once per burst of `schedule(key)` calls, `delayMs` after the first. A schedule
 * while that key's run is in flight runs it once more afterwards, so the last change is never
 * missed. `run` must handle its own errors (they are swallowed here).
 */
export class Debouncer {
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private readonly running = new Set<number>();
  private readonly again = new Set<number>();
  private stopped = false;

  constructor(
    private readonly run: (key: number) => Promise<void>,
    private readonly delayMs: number,
  ) {}

  schedule(key: number): void {
    if (this.stopped) return;
    if (this.running.has(key)) {
      this.again.add(key);
      return;
    }
    if (this.timers.has(key)) return;
    this.timers.set(
      key,
      setTimeout(() => this.fire(key), this.delayMs),
    );
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.again.clear();
  }

  private fire(key: number): void {
    this.timers.delete(key);
    this.running.add(key);
    void this.run(key)
      .catch(() => {})
      .finally(() => {
        this.running.delete(key);
        if (this.again.delete(key)) this.schedule(key);
      });
  }
}

const MAX_FIELD = 1024;

/** Lines joined for an embed field, cut with `…` to fit, or "none". */
function fieldValue(lines: string[]): string {
  if (!lines.length) return 'none';
  const out: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > MAX_FIELD - 2) {
      out.push('…');
      break;
    }
    out.push(line);
    length += line.length + 1;
  }
  return out.join('\n');
}

/** The first message of #board: what the project is, its repos and its links. */
export function projectInfoEmbed(
  project: Pick<Project, 'name' | 'key' | 'template'>,
  repos: ProjectRepo[],
  links: { name: string; url: string }[],
): EmbedBuilder {
  return new EmbedBuilder().setTitle(`ℹ️ ${project.name} (${project.key})`).addFields(
    { name: 'Template', value: project.template, inline: true },
    {
      name: 'Repos',
      value: fieldValue(repos.map((r) => `${r.owner}/${r.name}${r.isDefault ? ' (default)' : ''}`)),
    },
    { name: 'Links', value: fieldValue(links.map((l) => `[${l.name}](${l.url})`)) },
  );
}
