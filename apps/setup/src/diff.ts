import { channelName, type Preset } from '@discord-kit/config';
import type { ServerSnapshot } from './snapshot.ts';

export interface DiffResult {
  /** In the preset, missing on the server (server:setup creates them). */
  missing: string[];
  /** On the server, not in the preset (server:prune would remove them). */
  extra: string[];
  /** Exists on both sides but differs (server:setup does not change existing things). */
  changed: string[];
}

/** Compares the preset with the server by name, the same way server:setup matches things. */
export function diffServer(preset: Preset, server: ServerSnapshot): DiffResult {
  const result: DiffResult = { missing: [], extra: [], changed: [] };

  const serverRoles = new Map(server.roles.map((r) => [r.name, r]));
  const presetRoles = new Set(preset.config.roles.map((r) => r.name));
  for (const spec of preset.config.roles) {
    const role = serverRoles.get(spec.name);
    if (!role) {
      result.missing.push(`role @${spec.name}`);
      continue;
    }
    const color = spec.color?.toUpperCase();
    if (color !== role.color)
      result.changed.push(`role @${spec.name}: color ${role.color ?? 'none'} → ${color ?? 'none'}`);
    if ((spec.hoist ?? false) !== role.hoist)
      result.changed.push(`role @${spec.name}: hoist ${role.hoist} → ${spec.hoist ?? false}`);
    const want = [...(spec.perms ?? [])].sort().join(', ') || 'none';
    const have = [...role.perms].sort().join(', ') || 'none';
    if (want !== have) result.changed.push(`role @${spec.name}: permissions ${have} → ${want}`);
  }
  for (const role of server.roles) if (!presetRoles.has(role.name)) result.extra.push(`role @${role.name}`);

  const serverCats = new Map(server.categories.map((c) => [c.name, c]));
  const presetCats = new Set(preset.config.categories.map((c) => c.name));
  for (const cat of preset.config.categories) {
    const found = serverCats.get(cat.name);
    if (!found) {
      result.missing.push(`category ${cat.name} (with ${cat.channels?.length ?? 0} channels)`);
      continue;
    }
    const serverChannels = new Map(found.channels.map((c) => [c.name, c]));
    const wanted = new Set<string>();
    for (const ch of cat.channels ?? []) {
      const name = channelName(ch);
      wanted.add(name);
      const existing = serverChannels.get(name);
      const label = `${cat.name} / ${ch.type === 'voice' ? '🔊 ' : '#'}${name}`;
      if (!existing) result.missing.push(`channel ${label}`);
      else if (existing.type !== (ch.type ?? 'text')) {
        result.changed.push(`channel ${label}: type ${existing.type} → ${ch.type ?? 'text'}`);
      }
    }
    for (const ch of found.channels)
      if (!wanted.has(ch.name)) result.extra.push(`channel ${cat.name} / ${ch.name}`);
  }
  for (const cat of server.categories) {
    if (!presetCats.has(cat.name))
      result.extra.push(`category ${cat.name} (with ${cat.channels.length} channels)`);
  }
  for (const ch of server.uncategorized) result.extra.push(`channel ${ch.name} (no category)`);
  return result;
}

export function printDiff(diff: DiffResult): void {
  const section = (title: string, items: string[], mark: string) => {
    console.log(`${title} (${items.length})`);
    for (const item of items) console.log(`  ${mark} ${item}`);
  };
  section('MISSING ON THE SERVER, created by server:setup', diff.missing, '+');
  section('ONLY ON THE SERVER, not in the preset', diff.extra, '-');
  section('DIFFERENT, server:setup does not change existing things', diff.changed, '~');
  if (!diff.missing.length && !diff.extra.length && !diff.changed.length)
    console.log('\nThe server matches the preset.');
}
