import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
  type ModalSubmitInteraction,
  type SendableChannels,
} from 'discord.js';
import { ConfigError, featureConfig, type ApplicationsSpec, type Preset } from '@discord-kit/config';
import type { Feature } from '../feature.ts';
import { applicationsStore, type Application, type ApplicationsStore } from './applications-store.ts';

const PREFIX = 'applications:';
const APPLY = `${PREFIX}apply`;
const FORM = `${PREFIX}form`;
const ACCEPT = `${PREFIX}accept:`;
const REJECT = `${PREFIX}reject:`;

const DEFAULTS = {
  title: 'Applications',
  message: 'Press the button below and fill in the form.',
  button_label: 'Apply',
  form_title: 'Application',
  submitted_reply: 'Thanks, your application was sent. You will get a message when it is reviewed.',
  pending_reply: 'You already have an application waiting for review.',
  accepted_dm: 'Your application to {server} was accepted. Welcome!',
  rejected_dm: 'Your application to {server} was not accepted this time.',
  error_reply: 'Something went wrong, please try again.',
};

type Texts = typeof DEFAULTS;

const STAFF_DEFAULTS = {
  review_title: 'Application #{id}',
  accept_label: 'Accept',
  reject_label: 'Reject',
  accepted: '✅ Accepted by {reviewer}',
  rejected: '❌ Rejected by {reviewer}',
  not_reviewer: 'You are not allowed to review applications.',
  not_found: 'Application #{id} not found.',
  already_reviewed: 'Application #{id} was already reviewed.',
  roles_failed: 'could not change roles',
  dm_closed: 'DM closed',
  member_left: 'the member left the server',
};

type StaffTexts = typeof STAFF_DEFAULTS;

export function staffTexts(cfg: ApplicationsSpec): StaffTexts {
  return {
    ...STAFF_DEFAULTS,
    ...Object.fromEntries(Object.entries(cfg.staff_texts ?? {}).filter(([, v]) => v)),
  };
}

/** Replaces {key} placeholders with the given values. */
export function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));
}

export function texts(cfg: ApplicationsSpec): Texts {
  return Object.fromEntries(
    Object.entries(DEFAULTS).map(([k, v]) => [k, cfg[k as keyof Texts] ?? v]),
  ) as Texts;
}

export function fill(template: string, values: { name: string; server: string }): string {
  return template.replaceAll('{name}', values.name).replaceAll('{server}', values.server);
}

/** Discord limits an embed field value to 1024 characters. */
export function clip(text: string, max = 1024): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

function isReviewer(member: GuildMember, cfg: ApplicationsSpec, preset: Preset): boolean {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const allowed = new Set(cfg.reviewer_roles ?? preset.config.bot?.admin_roles ?? []);
  return member.roles.cache.some((r) => allowed.has(r.name));
}

function findTextChannel(guild: Guild, name: string): SendableChannels {
  const channel = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === name);
  if (!channel?.isSendable()) throw new ConfigError(`Channel #${name} not found`);
  return channel;
}

function findRoles(guild: Guild, names: string[] = []) {
  return names.map((n) => {
    const role = guild.roles.cache.find((r) => r.name === n);
    if (!role) throw new ConfigError(`Role @${n} not found, run pnpm server:setup first`);
    return role;
  });
}

function reviewEmbed(app: Application, member: GuildMember | null, userTag: string, st: StaffTexts) {
  const embed = new EmbedBuilder()
    .setTitle(format(st.review_title, { id: app.id }))
    .setDescription(member ? `${member.toString()} (${userTag})` : userTag)
    .setTimestamp(new Date(app.createdAt));
  for (const [question, answer] of Object.entries(app.answers)) {
    embed.addFields({ name: question, value: clip(answer || '—') });
  }
  return embed;
}

function reviewButtons(id: number, st: StaffTexts, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ACCEPT}${id}`)
      .setLabel(st.accept_label)
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${REJECT}${id}`)
      .setLabel(st.reject_label)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

function buildForm(cfg: ApplicationsSpec, t: Texts): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(FORM).setTitle(t.form_title);
  cfg.questions.forEach((q, i) => {
    const input = new TextInputBuilder()
      .setCustomId(`q${i}`)
      .setLabel(q.label)
      .setStyle(q.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(q.required ?? true);
    if (q.placeholder) input.setPlaceholder(q.placeholder);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  });
  return modal;
}

async function onSubmit(
  interaction: ModalSubmitInteraction<'cached'>,
  cfg: ApplicationsSpec,
  t: Texts,
  store: ApplicationsStore,
  review: SendableChannels,
) {
  if (store.pendingApplication(interaction.user.id)) {
    await interaction.reply({ content: t.pending_reply, flags: MessageFlags.Ephemeral });
    return;
  }
  const answers = Object.fromEntries(
    cfg.questions.map((q, i) => [q.label, interaction.fields.getTextInputValue(`q${i}`)]),
  );
  const app = store.createApplication(interaction.user.id, answers);
  await review.send({
    embeds: [reviewEmbed(app, interaction.member, interaction.user.tag, staffTexts(cfg))],
    components: [reviewButtons(app.id, staffTexts(cfg))],
    allowedMentions: { parse: [] },
  });
  await interaction.reply({ content: t.submitted_reply, flags: MessageFlags.Ephemeral });
}

async function onDecision(
  interaction: ButtonInteraction<'cached'>,
  accepted: boolean,
  cfg: ApplicationsSpec,
  t: Texts,
  ctx: { guild: Guild; preset: Preset; store: ApplicationsStore },
) {
  const st = staffTexts(cfg);
  if (!isReviewer(interaction.member, cfg, ctx.preset)) {
    await interaction.reply({
      content: st.not_reviewer,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const prefix = accepted ? ACCEPT : REJECT;
  const id = Number(interaction.customId.slice(prefix.length));
  const app = ctx.store.application(id);
  if (!app) {
    await interaction.reply({ content: format(st.not_found, { id }), flags: MessageFlags.Ephemeral });
    return;
  }
  if (!ctx.store.decideApplication(id, accepted ? 'accepted' : 'rejected', interaction.user.tag)) {
    await interaction.reply({
      content: format(st.already_reviewed, { id }),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = await ctx.guild.members.fetch(app.userId).catch(() => null);
  const problems: string[] = [];
  if (accepted && member) {
    const add = findRoles(ctx.guild, cfg.accept_roles);
    const remove = findRoles(ctx.guild, cfg.remove_roles);
    if (add.length)
      await member.roles.add(add, `application #${id}`).catch(() => problems.push(st.roles_failed));
    if (remove.length) {
      await member.roles.remove(remove, `application #${id}`).catch(() => problems.push(st.roles_failed));
    }
  }
  if (member) {
    const dm = fill(accepted ? t.accepted_dm : t.rejected_dm, {
      name: member.displayName,
      server: ctx.guild.name,
    });
    await member.send(dm).catch(() => problems.push(st.dm_closed));
  } else {
    problems.push(st.member_left);
  }

  const template = accepted ? st.accepted : st.rejected;
  const verdict = format(template, { reviewer: interaction.user.toString() });
  const unique = [...new Set(problems)];
  const embed = EmbedBuilder.from(interaction.message.embeds[0]!).setFooter({
    text:
      format(template, { reviewer: interaction.user.tag }) + (unique.length ? ` (${unique.join(', ')})` : ''),
  });
  await interaction.update({
    content: verdict,
    embeds: [embed],
    components: [reviewButtons(id, st, true)],
    allowedMentions: { parse: [] },
  });
}

/**
 * Applications: a button in `channel` opens a form; submissions land in `review_channel`
 * with accept/reject buttons. Accepting gives `accept_roles` and removes `remove_roles`.
 */
export const applications: Feature = {
  name: 'applications',
  intents: [GatewayIntentBits.Guilds],

  async start({ client, guild, preset, db, on, log }) {
    const store = applicationsStore(db);
    const cfg = featureConfig(preset, 'applications');
    if (!cfg) throw new ConfigError('features.applications is not configured in config.yaml');
    const t = texts(cfg);
    const channel = findTextChannel(guild, cfg.channel);
    const review = findTextChannel(guild, cfg.review_channel);
    findRoles(guild, [...(cfg.accept_roles ?? []), ...(cfg.remove_roles ?? [])]);

    on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.inCachedGuild() || interaction.guildId !== guild.id) return;
      try {
        if (interaction.isButton() && interaction.customId === APPLY) {
          if (store.pendingApplication(interaction.user.id)) {
            await interaction.reply({ content: t.pending_reply, flags: MessageFlags.Ephemeral });
          } else {
            await interaction.showModal(buildForm(cfg, t));
          }
        } else if (interaction.isModalSubmit() && interaction.customId === FORM) {
          await onSubmit(interaction, cfg, t, store, review);
        } else if (interaction.isButton() && interaction.customId.startsWith(ACCEPT)) {
          await onDecision(interaction, true, cfg, t, { guild, preset, store });
        } else if (interaction.isButton() && interaction.customId.startsWith(REJECT)) {
          await onDecision(interaction, false, cfg, t, { guild, preset, store });
        }
      } catch (e) {
        log.error('applications', 'interaction failed', e);
        if (interaction.isRepliable() && !interaction.replied) {
          await interaction.reply({ content: t.error_reply, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
      }
    });

    // Post the message with the button, or update it when the config changed.
    const payload = {
      content: `**${t.title}**\n${t.message}`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(APPLY).setLabel(t.button_label).setStyle(ButtonStyle.Primary),
        ),
      ],
    };
    const history = await channel.messages.fetch({ limit: 50 });
    const existing = history.find(
      (m) =>
        m.author.id === client.user.id &&
        m.components.some(
          (row) => 'components' in row && row.components.some((c) => 'customId' in c && c.customId === APPLY),
        ),
    );
    if (existing) await existing.edit(payload);
    else await channel.send(payload);
  },
};
