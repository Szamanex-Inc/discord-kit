/** A project can keep up to this many links (Figma, Trello, docs, …). */
export const MAX_LINKS = 25;
export const LINK_NAME_MAX = 50;

/** Only web links: `http(s)://` with a host. */
export function isValidLinkUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}
