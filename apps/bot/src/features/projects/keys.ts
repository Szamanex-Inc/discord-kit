const MAX_KEY = 6;

/**
 * A ticket key prefix from a project name: the initials of its words ("discord-kit" → DK), or the
 * first three letters of a one-word name ("Murmur" → MUR). The result may be too short to be valid
 * (a one-letter name); /project create then asks for an explicit key.
 */
export function deriveKey(name: string): string {
  const words = name
    .split(/[\s_-]+/)
    .map((w) => w.replace(/[^a-z]/gi, ''))
    .filter(Boolean);
  const key = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? '').slice(0, 3);
  return key.toUpperCase().slice(0, MAX_KEY);
}

export function isValidKey(key: string): boolean {
  return /^[A-Z]{2,6}$/.test(key);
}

/** A GitHub URL or SSH address reduced to owner/name; anything else is returned as is. */
function normalizeRepo(entry: string): string {
  return entry
    .replace(/^git@github\.com:/i, '')
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
}

/**
 * `owner/name` entries separated by commas or spaces, without duplicates. Also accepts GitHub URLs
 * and a pasted option name (`repo:acme/web`).
 */
export function parseRepos(input: string): { owner: string; name: string }[] {
  const seen = new Set<string>();
  const out: { owner: string; name: string }[] = [];
  const entries = input
    .replace(/\brepo:\s*/gi, '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(normalizeRepo);
  for (const entry of entries) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(entry))
      throw new Error(`'${entry}' is not a repository: type only owner/name, e.g. acme/web`);
    if (seen.has(entry)) continue;
    seen.add(entry);
    const [owner = '', name = ''] = entry.split('/');
    out.push({ owner, name });
  }
  return out;
}

/** The project role's name from `role_format`, e.g. 'Project: {name}'. */
export function roleName(format: string, name: string): string {
  return format.replaceAll('{name}', name);
}

/** An issue given as `acme/web#42` or `https://github.com/acme/web/issues/42`. */
export function parseIssueRef(input: string): { owner: string; name: string; number: number } | undefined {
  const text = input.trim();
  const m =
    /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(text) ??
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)\/?$/i.exec(text);
  return m ? { owner: m[1]!, name: m[2]!, number: Number(m[3]) } : undefined;
}
