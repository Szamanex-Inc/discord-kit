import {
  ChannelType,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type SendableChannels,
} from 'discord.js';
import { ConfigError, featureConfig, type EventsSpec, type Preset } from '@discord-kit/config';
import type { Feature, FeatureContext } from '../feature.ts';
import { eventsStore, type StoredEvent } from './events-store.ts';

const DEFAULTS = {
  timezone: 'UTC',
  remind_before: [60, 15],
  default_duration: 120,
  announce: '📅 **{title}** {time} ({relative}) {ping}\n{link}',
  reminder: '⏰ **{title}** starts {relative} {ping}\n{link}',
  cancelled: '❌ **{title}** ({time}) was cancelled.',
};

/** How often due reminders are checked. */
const TICK_MS = 30_000;

/**
 * Converts a wall-clock time in `timeZone` to a Date. Works without a date library by measuring the
 * zone's offset at that moment (twice, so times right after a DST switch come out right).
 */
export function zonedTime(date: string, time: string, timeZone: string): Date | undefined {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!d || !t) return undefined;
  const [y, mo, da] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const [h, mi] = [Number(t[1]), Number(t[2])];
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59) return undefined;
  const wall = Date.UTC(y, mo - 1, da, h, mi);
  const offset = (at: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(at));
    const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')) - at;
  };
  let utc = wall - offset(wall);
  utc = wall - offset(utc);
  const result = new Date(utc);
  // Reject dates that do not exist, e.g. 2026-02-30.
  return new Date(wall).getUTCDate() === da ? result : undefined;
}

/** Reminders that are due at `now` and not posted yet, as `remind_before` minutes. */
export function dueReminders(event: StoredEvent, remindBefore: number[], now: Date): number[] {
  const left = (event.startsAt.getTime() - now.getTime()) / 60_000;
  return remindBefore.filter((m) => left <= m && left > 0 && !event.remindersSent.includes(m));
}

export function fillEvent(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all).trim();
}

function settings(preset: Preset): EventsSpec & typeof DEFAULTS {
  const cfg = featureConfig(preset, 'events');
  if (!cfg) throw new ConfigError('features.events is not configured in config.yaml');
  return {
    ...DEFAULTS,
    ...Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined)),
  } as EventsSpec & typeof DEFAULTS;
}

function channelOf(guild: Guild, name: string): SendableChannels {
  const channel = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === name);
  if (!channel?.isSendable()) throw new ConfigError(`Channel #${name} not found`);
  return channel;
}

const isAdmin = (member: GuildMember) => member.permissions.has(PermissionFlagsBits.Administrator);
const hasOrganizerRole = (member: GuildMember, cfg: EventsSpec) =>
  member.roles.cache.some((r) => (cfg.organizer_roles ?? []).includes(r.name));

/** Without organizer_roles everyone can create events. */
function canCreate(member: GuildMember, cfg: EventsSpec): boolean {
  return !cfg.organizer_roles?.length || isAdmin(member) || hasOrganizerRole(member, cfg);
}

/** The organizer, an admin or an organizer role can cancel. */
function canCancel(member: GuildMember, cfg: EventsSpec, event: StoredEvent): boolean {
  return event.organizerId === member.id || isAdmin(member) || hasOrganizerRole(member, cfg);
}

function values(guild: Guild, e: StoredEvent, link: string) {
  const unix = Math.floor(e.startsAt.getTime() / 1000);
  const role = e.pingRole ? guild.roles.cache.find((r) => r.name === e.pingRole) : undefined;
  return {
    title: e.title,
    time: `<t:${unix}:F>`,
    relative: `<t:${unix}:R>`,
    link,
    ping: role ? role.toString() : '',
    organizer: `<@${e.organizerId}>`,
  };
}

const eventLink = (guild: Guild, discordEventId: string) =>
  `https://discord.com/events/${guild.id}/${discordEventId}`;

async function create(interaction: ChatInputCommandInteraction<'cached'>, ctx: FeatureContext) {
  const cfg = settings(ctx.preset);
  if (!canCreate(interaction.member, cfg)) {
    await interaction.reply({
      content: 'You are not allowed to create events.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const title = interaction.options.getString('title', true);
  const date = interaction.options.getString('date', true);
  const time = interaction.options.getString('time', true);
  const startsAt = zonedTime(date, time, cfg.timezone);
  if (!startsAt) {
    await interaction.reply({
      content: `Could not read the date/time. Use YYYY-MM-DD and HH:MM (${cfg.timezone}).`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (startsAt.getTime() <= Date.now()) {
    await interaction.reply({
      content: 'The event has to start in the future.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const pingRole = interaction.options.getString('ping') ?? undefined;
  const duration = interaction.options.getInteger('duration') ?? cfg.default_duration;
  const description = interaction.options.getString('description') ?? undefined;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const scheduled = await ctx.guild.scheduledEvents.create({
    name: title,
    scheduledStartTime: startsAt,
    scheduledEndTime: new Date(startsAt.getTime() + duration * 60_000),
    privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
    entityType: GuildScheduledEventEntityType.External,
    entityMetadata: { location: `#${cfg.channel}` },
    ...(description && { description }),
    reason: `/event create by ${interaction.user.tag}`,
  });
  const event = eventsStore(ctx.db).createEvent({
    discordEventId: scheduled.id,
    title,
    startsAt,
    ...(pingRole && { pingRole }),
    organizerId: interaction.user.id,
  });
  const link = eventLink(ctx.guild, scheduled.id);
  await channelOf(ctx.guild, cfg.channel).send({
    content: fillEvent(cfg.announce, values(ctx.guild, event, link)),
    allowedMentions: {
      roles: [ctx.guild.roles.cache.find((r) => r.name === pingRole)?.id].filter((id) => id !== undefined),
    },
  });
  await interaction.editReply(`Event #${event.id} created: ${link}`);
}

async function list(interaction: ChatInputCommandInteraction<'cached'>, ctx: FeatureContext) {
  const events = eventsStore(ctx.db).upcomingEvents(new Date());
  const lines = events.map((e) => {
    const v = values(ctx.guild, e, eventLink(ctx.guild, e.discordEventId));
    return `#${e.id} **${e.title}** ${v.time} (${v.relative})`;
  });
  await interaction.reply({
    content: lines.join('\n') || 'No upcoming events.',
    flags: MessageFlags.Ephemeral,
  });
}

async function cancel(interaction: ChatInputCommandInteraction<'cached'>, ctx: FeatureContext) {
  const cfg = settings(ctx.preset);
  const id = interaction.options.getInteger('id', true);
  const event = eventsStore(ctx.db).event(id);
  if (!event || event.cancelled) {
    await interaction.reply({ content: `No active event #${id}.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!canCancel(interaction.member, cfg, event)) {
    await interaction.reply({
      content: 'Only the organizer or an event organizer role can cancel this event.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  eventsStore(ctx.db).cancelEvent(id);
  await ctx.guild.scheduledEvents.delete(event.discordEventId).catch(() => {});
  await channelOf(ctx.guild, cfg.channel).send({
    content: fillEvent(cfg.cancelled, values(ctx.guild, event, '')),
    allowedMentions: { parse: [] },
  });
  await interaction.reply({ content: `Event #${id} cancelled.`, flags: MessageFlags.Ephemeral });
}

/** Posts the reminders that are due; runs every TICK_MS while the module is enabled. */
async function tick(ctx: FeatureContext): Promise<void> {
  const cfg = settings(ctx.preset);
  const channel = channelOf(ctx.guild, cfg.channel);
  const now = new Date();
  for (const event of eventsStore(ctx.db).upcomingEvents(now)) {
    const due = dueReminders(event, cfg.remind_before, now);
    if (!due.length) continue;
    // Several due at once (e.g. after a restart): post one reminder, mark all as sent.
    const role = event.pingRole ? ctx.guild.roles.cache.find((r) => r.name === event.pingRole) : undefined;
    await channel.send({
      content: fillEvent(cfg.reminder, values(ctx.guild, event, eventLink(ctx.guild, event.discordEventId))),
      allowedMentions: { roles: role ? [role.id] : [] },
    });
    for (const m of due) eventsStore(ctx.db).markReminderSent(event.id, m);
  }
}

const timers = new Map<string, NodeJS.Timeout>();

function command(preset: Preset) {
  const pingRoles = featureConfig(preset, 'events')?.ping_roles ?? [];
  return new SlashCommandBuilder()
    .setName('event')
    .setDescription('Create, list or cancel events')
    .addSubcommand((s) => {
      s.setName('create')
        .setDescription('Create an event with reminders')
        .addStringOption((o) =>
          o.setName('title').setDescription('Event name').setRequired(true).setMaxLength(100),
        )
        .addStringOption((o) => o.setName('date').setDescription('YYYY-MM-DD').setRequired(true))
        .addStringOption((o) => o.setName('time').setDescription('HH:MM').setRequired(true));
      if (pingRoles.length) {
        s.addStringOption((o) =>
          o
            .setName('ping')
            .setDescription('Role to ping')
            .addChoices(...pingRoles.map((r) => ({ name: r, value: r }))),
        );
      }
      return s
        .addIntegerOption((o) =>
          o.setName('duration').setDescription('Length in minutes').setMinValue(5).setMaxValue(1440),
        )
        .addStringOption((o) => o.setName('description').setDescription('Details').setMaxLength(1000));
    })
    .addSubcommand((s) => s.setName('list').setDescription('Upcoming events'))
    .addSubcommand((s) =>
      s
        .setName('cancel')
        .setDescription('Cancel an event')
        .addIntegerOption((o) =>
          o.setName('id').setDescription('Event number from /event list').setRequired(true),
        ),
    )
    .toJSON();
}

/**
 * Events: `/event create` makes a Discord scheduled event, announces it in `channel` with an optional
 * role ping and posts reminders `remind_before` minutes before the start. `/event list` and `/event cancel`.
 */
export const events: Feature = {
  name: 'events',
  intents: [],
  // Built from the preset on every registration, so the ping choices follow reloads.
  commands: (preset) => [
    {
      data: command(preset),
      async execute(interaction, ctx) {
        const sub = interaction.options.getSubcommand();
        if (sub === 'create') await create(interaction, ctx);
        else if (sub === 'list') await list(interaction, ctx);
        else await cancel(interaction, ctx);
      },
    },
  ],

  async start(ctx) {
    const cfg = settings(ctx.preset);
    channelOf(ctx.guild, cfg.channel);
    const run = () => void tick(ctx).catch((e) => ctx.log.error('events', 'posting reminders failed', e));
    run();
    timers.set(ctx.guild.id, setInterval(run, TICK_MS));
  },

  async stop(ctx) {
    clearInterval(timers.get(ctx.guild.id));
    timers.delete(ctx.guild.id);
  },
};
