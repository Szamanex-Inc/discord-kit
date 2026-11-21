import { ChannelType, DiscordAPIError, type Guild, type GuildChannelCreateOptions } from 'discord.js';
import { channelName, type Preset } from '@discord-kit/config';
import {
  buildOverwrites,
  configuredChannels,
  findCategory,
  permFlag,
  REASON,
  toDiscordOverwrites,
  type RoleMap,
} from './discord.ts';

/** Creates missing roles, categories and channels. Never deletes or modifies anything. */
export async function runSetup(guild: Guild, preset: Preset): Promise<void> {
  console.log(`Server: ${guild.name}\nROLES:`);
  const roles = await ensureRoles(guild, preset);
  console.log('CHANNELS:');
  await ensureChannels(guild, preset, roles);
  await ensureSystemChannel(guild, preset);
  console.log('\nDone. Nothing was deleted.');
  console.log('Post channel content (rules, announcements, ...) with: pnpm server:publish');
}

async function ensureRoles(guild: Guild, preset: Preset): Promise<RoleMap> {
  const existing = new Map(guild.roles.cache.map((r) => [r.name, r]));
  const roles: RoleMap = {};
  for (const spec of preset.config.roles) {
    const found = existing.get(spec.name);
    if (found) {
      roles[spec.name] = found;
      console.log(`  = @${spec.name} (already exists)`);
      continue;
    }
    roles[spec.name] = await guild.roles.create({
      name: spec.name,
      hoist: spec.hoist ?? false,
      mentionable: spec.mentionable ?? false,
      permissions: (spec.perms ?? []).map(permFlag),
      ...(spec.color && { colors: { primaryColor: parseInt(spec.color.replace('#', ''), 16) } }),
      reason: REASON,
    });
    console.log(`  + @${spec.name}`);
  }

  // Order roles as in the config, right below the bot's highest role.
  const top = guild.members.me!.roles.highest.position;
  const ordered = preset.config.roles.map((s) => roles[s.name]!);
  const movable = ordered.filter((r) => r.position < top);
  if (movable.length < ordered.length) {
    const skipped = ordered.filter((r) => !movable.includes(r)).map((r) => r.name);
    console.log(`  ! Cannot move roles above the bot's role: ${skipped.join(', ')}`);
  }
  let pos = top - 1;
  const positions = movable.map((r) => ({ role: r.id, position: Math.max(pos--, 1) }));
  try {
    await guild.roles.setPositions(positions);
    console.log('  ~ role order updated');
  } catch (e) {
    console.log(`  ! Could not reorder roles (${(e as Error).message}). Drag them into place manually.`);
  }
  return roles;
}

async function ensureChannels(guild: Guild, preset: Preset, roles: RoleMap): Promise<void> {
  for (const catSpec of preset.config.categories) {
    const catOw = buildOverwrites(guild, roles, preset, catSpec);
    let cat = findCategory(guild, catSpec.name);
    if (!cat) {
      cat = await guild.channels.create({
        name: catSpec.name,
        type: ChannelType.GuildCategory,
        permissionOverwrites: toDiscordOverwrites(catOw),
        reason: REASON,
      });
      console.log(`  + ${catSpec.name}`);
    } else {
      console.log(`  = ${catSpec.name} (already exists)`);
    }

    for (const ch of catSpec.channels ?? []) {
      const kind = ch.type ?? 'text';
      const name = channelName(ch);
      if (guild.channels.cache.some((c) => c.parentId === cat.id && c.name === name)) {
        console.log(`    = ${name} (already exists)`);
        continue;
      }
      const own = ch.private?.length || ch.members_only || ch.read_only;
      const ow = own ? buildOverwrites(guild, roles, preset, ch, catOw) : catOw;
      const common = {
        name,
        parent: cat.id,
        permissionOverwrites: toDiscordOverwrites(ow),
        reason: REASON,
      };
      const byKind: Record<string, GuildChannelCreateOptions> = {
        voice: { ...common, type: ChannelType.GuildVoice, userLimit: ch.user_limit ?? 0 },
        forum: { ...common, type: ChannelType.GuildForum, topic: ch.topic },
        announcement: { ...common, type: ChannelType.GuildAnnouncement, topic: ch.topic },
        text: { ...common, type: ChannelType.GuildText, topic: ch.topic },
      };
      try {
        await guild.channels.create(byKind[kind] ?? byKind.text!);
        console.log(`    + ${name} [${kind}]`);
      } catch (e) {
        if ((kind === 'forum' || kind === 'announcement') && e instanceof DiscordAPIError) {
          // Forum/announcement channels may require Community mode, fall back to a text channel.
          await guild.channels.create(byKind.text!);
          console.log(`    + ${name} [text, ${kind} unavailable: ${e.message}]`);
        } else {
          throw e;
        }
      }
    }
  }
}

async function ensureSystemChannel(guild: Guild, preset: Preset): Promise<void> {
  for (const [spec, channel] of configuredChannels(guild, preset)) {
    if (!spec.system_channel || channel?.type !== ChannelType.GuildText) continue;
    if (guild.systemChannelId === channel.id) {
      console.log(`  = join messages already go to #${channel.name}`);
    } else {
      await guild.setSystemChannel(channel, REASON);
      console.log(`  ~ join messages will go to #${channel.name}`);
    }
    return;
  }
}
