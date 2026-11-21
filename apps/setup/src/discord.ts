import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  type CategoryChannel,
  type Guild,
  type GuildBasedChannel,
  type OverwriteResolvable,
  type Role,
} from 'discord.js';
import {
  channelName,
  ConfigError,
  type AccessSpec,
  type ChannelSpec,
  type Preset,
} from '@discord-kit/config';

import { toSnakeCase } from './snapshot.ts';

export const REASON = 'discord-kit setup';

export type PermissionName = keyof typeof PermissionFlagsBits;
export type RoleMap = Record<string, Role>;

/** Permissions per role/user: true = allow, false = deny, missing = inherited. */
export type Overwrites = Map<string, Partial<Record<PermissionName, boolean>>>;

/** Preset permission names (`manage_messages`, `use_vad`) mapped to Discord's flags. */
const PERMISSIONS_BY_SNAKE_NAME = new Map(
  Object.entries(PermissionFlagsBits).map(([key, bit]) => [toSnakeCase(key), bit] as const),
);

/** `manage_messages` -> the ManageMessages flag. */
export function permFlag(name: string): bigint {
  const flag = PERMISSIONS_BY_SNAKE_NAME.get(name);
  if (flag === undefined) throw new ConfigError(`Unknown permission in config.yaml: '${name}'`);
  return flag;
}

/** Builds category/channel permission overwrites. `base` = category overwrites the channel inherits. */
export function buildOverwrites(
  guild: Guild,
  roles: RoleMap,
  preset: Preset,
  spec: AccessSpec,
  base?: Overwrites,
): Overwrites {
  const ow: Overwrites = new Map();
  for (const [id, perms] of base ?? []) ow.set(id, { ...perms });
  const everyone = guild.roles.everyone.id;
  const role = (name: string) => roles[name]!.id;
  const get = (id: string) => {
    let o = ow.get(id);
    if (!o) ow.set(id, (o = {}));
    return o;
  };

  if (spec.private?.length) {
    get(everyone).ViewChannel = false;
    for (const name of spec.private) get(role(name)).ViewChannel = true;
  } else if (spec.members_only) {
    get(everyone).ViewChannel = false;
    for (const name of preset.memberRoles) get(role(name)).ViewChannel = true;
  }

  if (spec.read_only) {
    Object.assign(get(everyone), {
      SendMessages: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      SendMessagesInThreads: true,
      AddReactions: true,
    });
    // If the channel is members-only, member roles cannot post either.
    for (const name of preset.memberRoles) {
      const o = ow.get(role(name));
      if (o) o.SendMessages = false;
    }
    for (const name of spec.writers ?? []) get(role(name)).SendMessages = true;
  }
  return ow;
}

export function toDiscordOverwrites(ow: Overwrites): OverwriteResolvable[] {
  return [...ow].map(([id, perms]) => {
    const entries = Object.entries(perms) as [PermissionName, boolean][];
    return {
      id,
      allow: entries.filter(([, v]) => v).map(([k]) => PermissionFlagsBits[k]),
      deny: entries.filter(([, v]) => !v).map(([k]) => PermissionFlagsBits[k]),
    };
  });
}

export function findCategory(guild: Guild, name: string): CategoryChannel | undefined {
  return guild.channels.cache.find(
    (c): c is CategoryChannel => c.type === ChannelType.GuildCategory && c.name === name,
  );
}

/** Every channel from the config together with its counterpart on the server (if it exists). */
export function* configuredChannels(
  guild: Guild,
  preset: Preset,
): Generator<[ChannelSpec, GuildBasedChannel | undefined]> {
  for (const catSpec of preset.config.categories) {
    const cat = findCategory(guild, catSpec.name);
    for (const ch of catSpec.channels ?? []) {
      const found =
        cat && guild.channels.cache.find((c) => c.parentId === cat.id && c.name === channelName(ch));
      yield [ch, found];
    }
  }
}

/** Logs the bot in, runs `task` once connected to the server and disconnects. */
export async function withGuild(
  token: string,
  guildId: string,
  task: (client: Client<true>, guild: Guild) => Promise<void>,
): Promise<void> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const done = new Promise<void>((resolveDone, reject) => {
    const onReady = async (ready: Client<true>): Promise<void> => {
      try {
        const guild = await ready.guilds.fetch(guildId).catch(() => {
          throw new ConfigError('The bot cannot see a server with this GUILD_ID. Has it been invited?');
        });
        await guild.channels.fetch();
        await guild.roles.fetch();
        await task(ready, guild);
        await client.destroy();
        resolveDone();
      } catch (e) {
        await client.destroy();
        reject(e);
      }
    };
    // onReady handles its own errors; the listener itself must stay synchronous.
    client.once(Events.ClientReady, (ready) => void onReady(ready));
  });
  await client.login(token);
  await done;
}
