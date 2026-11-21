import {
  ActionRowBuilder,
  ChannelType,
  Events,
  GatewayIntentBits,
  MessageFlags,
  StringSelectMenuBuilder,
  type GuildMember,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { ConfigError, featureConfig, type RolePickerSpec } from '@discord-kit/config';
import type { Feature } from '../feature.ts';

const PREFIX = 'rolepicker:';
const DEFAULT_SAVED_REPLY = 'Saved. Your roles from this menu: {roles}';
const DEFAULT_CLEARED_REPLY = 'Saved. You have no roles from this menu now.';
const DEFAULT_ERROR_REPLY = 'Something went wrong, please try again.';

function buildRows(picker: RolePickerSpec) {
  return picker.menus.slice(0, 5).map((menu, i) =>
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`${PREFIX}${i}`)
        .setPlaceholder(menu.placeholder)
        .setMinValues(0)
        .setMaxValues(menu.roles.length)
        .addOptions(menu.roles.map((n) => ({ label: n, value: n }))),
    ),
  );
}

async function handlePick(picker: RolePickerSpec, interaction: StringSelectMenuInteraction<'cached'>) {
  const menu = picker.menus[Number(interaction.customId.slice(PREFIX.length))];
  if (!menu) return;
  const member: GuildMember = interaction.member;
  const chosen = new Set(interaction.values);
  const add = [];
  const remove = [];
  for (const name of menu.roles) {
    const role = interaction.guild.roles.cache.find((r) => r.name === name);
    if (!role) continue;
    const has = member.roles.cache.has(role.id);
    if (chosen.has(name) && !has) add.push(role);
    else if (!chosen.has(name) && has) remove.push(role);
  }
  if (add.length) await member.roles.add(add, 'role picker');
  if (remove.length) await member.roles.remove(remove, 'role picker');
  const content = chosen.size
    ? (picker.saved_reply ?? DEFAULT_SAVED_REPLY).replace('{roles}', [...chosen].sort().join(', '))
    : (picker.cleared_reply ?? DEFAULT_CLEARED_REPLY);
  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
  });
}

const DEFAULT_TITLE = 'Pick your roles';
const DEFAULT_MESSAGE = 'You can select several and change them at any time.';

/**
 * Role picker. On start it posts the menu to `features.role_picker.channel` or updates the existing one
 * (when the config changed), then handles selections while the bot runs.
 */
export const rolePicker: Feature = {
  name: 'role_picker',
  intents: [GatewayIntentBits.Guilds],

  async start({ client, guild, preset, on, log }) {
    const picker = featureConfig(preset, 'role_picker');
    if (!picker) throw new ConfigError('features.role_picker is not configured in config.yaml');

    // Handled by custom_id, so the menu keeps working after a bot restart.
    on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isStringSelectMenu() || !interaction.inCachedGuild()) return;
      if (!interaction.customId.startsWith(PREFIX)) return;
      try {
        await handlePick(picker, interaction);
      } catch (e) {
        log.error('role_picker', 'interaction failed', e);
        if (!interaction.replied) {
          await interaction
            .reply({ content: picker.error_reply ?? DEFAULT_ERROR_REPLY, flags: MessageFlags.Ephemeral })
            .catch(() => {});
        }
      }
    });

    const channel = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && c.name === picker.channel,
    );
    if (!channel?.isTextBased()) throw new ConfigError(`Channel #${picker.channel} not found`);

    const payload = {
      content: `**${picker.title ?? DEFAULT_TITLE}**\n${picker.message ?? DEFAULT_MESSAGE}`,
      components: buildRows(picker),
    };
    const history = await channel.messages.fetch({ limit: 50 });
    // The menu is recognized by component custom_id, not by text, so the title can change freely.
    const existing = history.find(
      (m) =>
        m.author.id === client.user.id &&
        m.components.some(
          (row) =>
            'components' in row &&
            row.components.some((c) => 'customId' in c && c.customId?.startsWith(PREFIX)),
        ),
    );
    if (existing) {
      await existing.edit(payload);
      log.info('role_picker', `updated the menu in #${channel.name}`);
    } else {
      await channel.send(payload);
      log.info('role_picker', `posted the menu to #${channel.name}`);
    }
  },
};
