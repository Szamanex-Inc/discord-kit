import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type SlashCommandStringOption,
} from 'discord.js';
import { FEATURES, type FeatureName, type Preset } from '@discord-kit/config';
import type { FeatureCommand } from '../feature.ts';
import type { FeatureManager, FeatureState } from '../manager.ts';

/** Administrator, or one of the preset's `bot.admin_roles`. */
export function isBotAdmin(interaction: ChatInputCommandInteraction<'cached'>, preset: Preset): boolean {
  if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const allowed = new Set(preset.config.bot?.admin_roles ?? []);
  return interaction.member.roles.cache.some((r) => allowed.has(r.name));
}

export function describeState(s: FeatureState): string {
  const value = s.enabled ? 'on' : 'off';
  let line = `**${s.name}**: ${value} (${s.source}`;
  if (s.source === 'override' && s.override)
    line += ` by ${s.override.updatedBy}, preset: ${s.preset ? 'on' : 'off'}`;
  line += ')';
  if (s.enabled && !s.running) line += ` ⚠️ not running${s.error ? `: ${s.error}` : ''}`;
  return line;
}

const nameOption = (o: SlashCommandStringOption) =>
  o
    .setName('name')
    .setDescription('Feature name')
    .setRequired(true)
    .addChoices(...FEATURES.map((n) => ({ name: n, value: n })));

/** `/feature list | on | off | reset`: shows and overrides feature flags at runtime. */
export function featureCommand(manager: Pick<FeatureManager, 'states' | 'setOverride'>): FeatureCommand {
  const data = new SlashCommandBuilder()
    .setName('feature')
    .setDescription('Show or change bot features')
    // Hidden from regular members in the command picker; the role check below is authoritative.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s.setName('list').setDescription('Show all features and where their state comes from'),
    )
    .addSubcommand((s) => s.setName('on').setDescription('Enable a feature now').addStringOption(nameOption))
    .addSubcommand((s) =>
      s.setName('off').setDescription('Disable a feature now').addStringOption(nameOption),
    )
    .addSubcommand((s) =>
      s
        .setName('reset')
        .setDescription('Remove the override, go back to the preset value')
        .addStringOption(nameOption),
    );

  return {
    data: data.toJSON(),
    async execute(interaction, ctx) {
      if (!isBotAdmin(interaction, ctx.preset)) {
        await interaction.reply({
          content: 'You are not allowed to use this command.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const sub = interaction.options.getSubcommand();
      if (sub === 'list') {
        const lines = manager.states().map(describeState);
        await interaction.reply({
          content: lines.join('\n') || 'No features.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const name = interaction.options.getString('name', true) as FeatureName;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const value = sub === 'on' ? true : sub === 'off' ? false : undefined;
      const state = await manager.setOverride(name, value, interaction.user.tag);
      const note = state.killed ? '\nDISABLED_FEATURES keeps it off until the variable is removed.' : '';
      await interaction.editReply(describeState(state) + note);
    },
  };
}
