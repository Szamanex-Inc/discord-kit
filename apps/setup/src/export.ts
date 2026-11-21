import YAML from 'yaml';
import { SCHEMA_VERSION } from '@discord-kit/config';
import type { ServerSnapshot, SnapshotChannel } from './snapshot.ts';

function channel(c: SnapshotChannel): Record<string, unknown> {
  return {
    name: c.name,
    ...(c.type !== 'text' && c.type !== 'other' && { type: c.type }),
    ...(c.topic && { topic: c.topic }),
    ...(c.userLimit && { user_limit: c.userLimit }),
  };
}

/**
 * Turns a server snapshot into a config.yaml that passes validation. Permission overwrites
 * (who can see or post) are not exported; review `private`, `members_only` and `read_only` by hand.
 */
export function exportPreset(server: ServerSnapshot, guildName: string): string {
  const skipped = server.categories
    .flatMap((c) => c.channels)
    .concat(server.uncategorized)
    .filter((c) => c.type === 'other');
  const config = {
    schema_version: SCHEMA_VERSION,
    roles: server.roles.map((r) => ({
      name: r.name,
      ...(r.color && { color: r.color }),
      ...(r.hoist && { hoist: true }),
      ...(r.mentionable && { mentionable: true }),
      ...(r.perms.length && { perms: r.perms }),
    })),
    categories: [
      ...server.categories.map((c) => ({
        name: c.name,
        channels: c.channels.filter((ch) => ch.type !== 'other').map(channel),
      })),
      // Presets keep every channel in a category, so loose channels get one.
      ...(server.uncategorized.some((c) => c.type !== 'other')
        ? [
            {
              name: 'NO CATEGORY',
              channels: server.uncategorized.filter((c) => c.type !== 'other').map(channel),
            },
          ]
        : []),
    ],
  };
  const header = [
    `# Exported from "${guildName}" on ${new Date().toISOString().slice(0, 10)} by discord-kit server:export.`,
    '# Permission overwrites are not exported: add private, members_only, read_only and writers by hand.',
    ...(skipped.length
      ? [`# Skipped unsupported channel types: ${skipped.map((c) => c.name).join(', ')}`]
      : []),
    '',
  ].join('\n');
  return header + YAML.stringify(config, { lineWidth: 0 });
}
