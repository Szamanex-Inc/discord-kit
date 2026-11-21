import type { StatusSpec } from '@discord-kit/config';

/** GitHub allows label names of at most 50 characters. */
const MAX_LABEL = 50;
/** Label colors by status position (hex without #). */
const PALETTE = ['1f6feb', 'd29922', '8957e5', 'cf222e', '2da44e', '0969da', 'bf8700', '6e7781'];

/**
 * The status labels the bot keeps on issues: prefix + status label, cut to 50 characters (a name
 * that collides after cutting gets " 2", " 3", …), colored by position.
 */
export function statusLabels(
  template: Pick<StatusSpec, 'key' | 'label'>[],
  prefix: string,
): { key: string; name: string; color: string }[] {
  const used = new Set<string>();
  return template.map((s, i) => {
    const full = prefix + s.label;
    let name = full.slice(0, MAX_LABEL);
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const suffix = ` ${n}`;
      name = full.slice(0, MAX_LABEL - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    return { key: s.key, name, color: PALETTE[i % PALETTE.length]! };
  });
}

/** The status named by an issue's labels (first status label found, case-insensitive). */
export function statusFromLabels(
  labelNames: string[],
  template: StatusSpec[],
  prefix: string,
): string | undefined {
  const byName = new Map(statusLabels(template, prefix).map((l) => [l.name.toLowerCase(), l.key]));
  for (const name of labelNames) {
    const key = byName.get(name.toLowerCase());
    if (key) return key;
  }
  return undefined;
}
