import { ChannelType, PermissionFlagsBits, type Guild, type GuildBasedChannel } from 'discord.js';
import type { ManagedIds } from './managed.ts';
import type { ChannelType as PresetChannelType } from '@discord-kit/config';

/** Plain view of a server's roles and channels, so diff and export can be tested without Discord. */
export interface ServerSnapshot {
  roles: { name: string; color?: string; hoist: boolean; mentionable: boolean; perms: string[] }[];
  categories: { name: string; channels: SnapshotChannel[] }[];
  /** Channels outside any category. */
  uncategorized: SnapshotChannel[];
}

export interface SnapshotChannel {
  name: string;
  type: PresetChannelType | 'other';
  topic?: string;
  userLimit?: number;
}

const TYPES: Partial<Record<ChannelType, PresetChannelType>> = {
  [ChannelType.GuildText]: 'text',
  [ChannelType.GuildVoice]: 'voice',
  [ChannelType.GuildForum]: 'forum',
  [ChannelType.GuildAnnouncement]: 'announcement',
};

/** `ManageMessages` -> `manage_messages`, the format used in presets. */
export function toSnakeCase(flag: string): string {
  return flag.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function channel(c: GuildBasedChannel): SnapshotChannel {
  const out: SnapshotChannel = { name: c.name, type: TYPES[c.type] ?? 'other' };
  if ('topic' in c && c.topic) out.topic = c.topic;
  if (c.type === ChannelType.GuildVoice && c.userLimit) out.userLimit = c.userLimit;
  return out;
}

const byPosition = (a: { position: number }, b: { position: number }) => a.position - b.position;

/** Reads the guild's roles (highest first) and channels (in display order). */
/** `exclude`: bot-managed project channels and roles, which presets do not list. */
export function snapshot(guild: Guild, exclude?: ManagedIds): ServerSnapshot {
  const roles = [...guild.roles.cache.values()]
    .filter((r) => r.id !== guild.roles.everyone.id && !r.managed && !exclude?.roleIds.has(r.id))
    .sort((a, b) => b.position - a.position)
    .map((r) => {
      const perms = Object.entries(PermissionFlagsBits)
        .filter(([, bit]) => r.permissions.has(bit, false))
        .map(([name]) => toSnakeCase(name));
      return {
        name: r.name,
        ...(r.color && { color: '#' + r.color.toString(16).padStart(6, '0').toUpperCase() }),
        hoist: r.hoist,
        mentionable: r.mentionable,
        // Administrator implies everything, so list only it.
        perms: perms.includes('administrator') ? ['administrator'] : perms,
      };
    });

  const isManaged = (id: string | null) => Boolean(id && exclude?.channelIds.has(id));
  const all = [...guild.channels.cache.values()].filter(
    (c) => !c.isThread() && !isManaged(c.id) && !isManaged(c.parentId),
  );
  const categories = all
    .filter((c) => c.type === ChannelType.GuildCategory)
    .sort((a, b) => byPosition(a as { position: number }, b as { position: number }))
    .map((cat) => ({
      name: cat.name,
      channels: all
        .filter((c) => c.parentId === cat.id)
        .sort((a, b) => byPosition(a as { position: number }, b as { position: number }))
        .map(channel),
    }));
  const uncategorized = all.filter((c) => c.type !== ChannelType.GuildCategory && !c.parentId).map(channel);
  return { roles, categories, uncategorized };
}
