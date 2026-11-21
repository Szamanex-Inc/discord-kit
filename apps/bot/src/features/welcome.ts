import { ChannelType, Events, GatewayIntentBits, type GuildMember } from 'discord.js';
import { ConfigError, featureConfig } from '@discord-kit/config';
import type { Feature } from '../feature.ts';

/** Fills {user}, {name}, {server} and {member_count} in a welcome template. */
export function renderWelcome(
  template: string,
  values: { mention: string; name: string; server: string; memberCount: number },
): string {
  return template
    .replaceAll('{user}', values.mention)
    .replaceAll('{name}', values.name)
    .replaceAll('{server}', values.server)
    .replaceAll('{member_count}', String(values.memberCount));
}

/**
 * Greets new members: a message in `channel`, an optional DM and `auto_roles`.
 * Needs the privileged Server Members intent (Developer Portal → Bot → Privileged Gateway Intents).
 */
export const welcome: Feature = {
  name: 'welcome',
  intents: [GatewayIntentBits.GuildMembers],

  async start({ guild, preset, on, log }) {
    const cfg = featureConfig(preset, 'welcome');
    if (!cfg) throw new ConfigError('features.welcome is not configured in config.yaml');

    const channel = cfg.channel
      ? guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === cfg.channel)
      : undefined;
    if (cfg.channel && !channel?.isTextBased()) throw new ConfigError(`Channel #${cfg.channel} not found`);

    const roles = (cfg.auto_roles ?? []).map((n) => {
      const role = guild.roles.cache.find((r) => r.name === n);
      if (!role) throw new ConfigError(`Role @${n} not found, run pnpm server:setup first`);
      return role;
    });

    on(Events.GuildMemberAdd, async (member: GuildMember) => {
      if (member.guild.id !== guild.id || member.user.bot) return;
      const values = {
        mention: member.toString(),
        name: member.displayName,
        server: guild.name,
        memberCount: guild.memberCount,
      };
      // Each step on its own, so one failure (e.g. missing permission) does not skip the others.
      if (roles.length) {
        await member.roles
          .add(roles, 'welcome auto_roles')
          .catch((e) => log.error('welcome', 'could not give auto_roles', e));
      }
      if (cfg.message && channel?.isTextBased()) {
        await channel
          .send({ content: renderWelcome(cfg.message, values), allowedMentions: { users: [member.id] } })
          .catch((e) => log.error('welcome', 'could not send the welcome message', e));
      }
      if (cfg.dm) {
        // Members with closed DMs reject this, which is expected.
        await member.send(renderWelcome(cfg.dm, values)).catch(() => {});
      }
    });
  },
};
