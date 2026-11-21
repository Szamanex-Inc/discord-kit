import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { FeatureCommand } from '../feature.ts';
import type { BuildInfo } from '../info.ts';
import type { FeatureManager } from '../manager.ts';
import { describeState, isBotAdmin } from './feature.ts';

export interface ReloadResult {
  at: Date;
  ok: boolean;
  /** Why the reload failed; the previous preset stays active. */
  error?: string;
}

export interface DeployInfo {
  build: BuildInfo;
  startedAt: Date;
  presetDir(): string;
  presetRevision(): string;
  lastReload(): ReloadResult | undefined;
  /** Reloads config.yaml from disk. */
  reload(): Promise<ReloadResult>;
}

const ts = (d: Date) => `<t:${Math.floor(d.getTime() / 1000)}:R>`;

export function statusText(info: DeployInfo, manager: Pick<FeatureManager, 'states'>): string {
  const last = info.lastReload();
  const lines = [
    `**discord-kit** ${info.build.version} (${info.build.revision}), started ${ts(info.startedAt)}`,
    `**Preset** ${info.presetDir()} @ ${info.presetRevision()}`,
    last
      ? `**Last reload** ${ts(last.at)}: ${last.ok ? 'ok' : `failed, previous preset kept: ${last.error}`}`
      : '**Last reload** none since start',
    '',
    ...manager.states().map(describeState),
  ];
  return lines.join('\n');
}

/** `/deploy status | reload`: what is live, and reloading the preset without a restart. */
export function deployCommand(info: DeployInfo, manager: Pick<FeatureManager, 'states'>): FeatureCommand {
  const data = new SlashCommandBuilder()
    .setName('deploy')
    .setDescription('Show what is deployed or reload the preset')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('status').setDescription('Version, preset commit and feature states'))
    .addSubcommand((s) => s.setName('reload').setDescription('Reload config.yaml without restarting'));

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
      if (interaction.options.getSubcommand() === 'reload') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await info.reload();
        const head = result.ok
          ? 'Preset reloaded.'
          : `Reload failed, the previous preset is still active:\n${result.error}`;
        await interaction.editReply(`${head}\n\n${statusText(info, manager)}`.slice(0, 2000));
        return;
      }
      await interaction.reply({
        content: statusText(info, manager).slice(0, 2000),
        flags: MessageFlags.Ephemeral,
      });
    },
  };
}
