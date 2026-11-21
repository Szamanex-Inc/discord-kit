import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import type { StatusSpec } from '@discord-kit/config';
import type { Ticket, TicketEventType } from './store.ts';

const MAX_POST_NAME = 100;
const MAX_TITLE_IN_LINE = 80;

const truncate = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

export function statusOf(template: StatusSpec[], key: string | null | undefined): StatusSpec | undefined {
  return template.find((s) => s.key === key);
}

/** `🟨 In progress`, or the raw key when the template no longer has that status. */
export function statusLabel(template: StatusSpec[], key: string): string {
  const s = statusOf(template, key);
  if (!s) return `unknown status \`${key}\``;
  return s.emoji ? `${s.emoji} ${s.label}` : s.label;
}

/** Name of a ticket's forum post: `DK-12 · Title`, at most 100 characters (Discord's limit). */
export function postName(ticket: Pick<Ticket, 'key' | 'title'>): string {
  return truncate(`${ticket.key} · ${ticket.title}`, MAX_POST_NAME);
}

/** The title part of a post name, without a leading key (`DK-12 · `, `DK-12 - `, `DK-12: `). */
export function splitPostName(name: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return name.replace(new RegExp(`^\\s*${escaped}\\s*[·:\\-–—]?\\s*`, 'i'), '').trim();
}

/** The ticket's linked issue as a link, or "none". */
function linksOf(ticket: Ticket): string {
  const i = ticket.issue;
  return i
    ? `[${i.owner}/${i.name}#${i.number}](https://github.com/${i.owner}/${i.name}/issues/${i.number})`
    : 'none';
}

/**
 * Members, then the linked issue's assignees that match no profile (`github: login (not linked)`)
 * with a hint about `/profile edit`, or "nobody". At most 1024 characters (Discord's field limit).
 */
function assigneesOf(ticket: Pick<Ticket, 'assignees' | 'unlinkedGithubLogins'>): string {
  const lines = ticket.assignees.length ? [ticket.assignees.map((id) => `<@${id}>`).join(', ')] : [];
  if (ticket.unlinkedGithubLogins.length) {
    lines.push(
      ...ticket.unlinkedGithubLogins.map((login) => `github: ${login} (not linked)`),
      '*Set your GitHub username with `/profile edit` to link it.*',
    );
  }
  return truncate(lines.join('\n'), 1024) || 'nobody';
}

/**
 * The bot's message in a ticket post: details and the controls. `showBody` puts the description in
 * it for bot-created posts. An edited description is also shown on posts made by hand.
 */
export function controlMessage(ticket: Ticket, template: StatusSpec[], opts: { showBody?: boolean } = {}) {
  const embed = new EmbedBuilder()
    .setTitle(truncate(`${ticket.key} · ${ticket.title}`, 256))
    .addFields(
      { name: 'Status', value: statusLabel(template, ticket.status), inline: true },
      { name: 'Assignees', value: assigneesOf(ticket), inline: true },
      { name: 'Links', value: linksOf(ticket), inline: true },
    );
  if (opts.showBody || ticket.bodyEdited) {
    if (ticket.body) embed.setDescription(truncate(ticket.body, 4096));
    else if (!opts.showBody) embed.setDescription('*Description cleared.*');
  }
  const blocked = template.find((s) => s.blocked);
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`ticket:take:${ticket.id}`)
      .setLabel('Take')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`ticket:leave:${ticket.id}`)
      .setLabel('Leave')
      .setStyle(ButtonStyle.Secondary),
  ];
  if (blocked && ticket.status === blocked.key) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`ticket:unblock:${ticket.id}`)
        .setLabel('Unblock')
        .setStyle(ButtonStyle.Success),
    );
  } else if (blocked) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`ticket:block:${ticket.id}`)
        .setLabel('Blocked')
        .setStyle(ButtonStyle.Danger),
    );
  }
  const move = new StringSelectMenuBuilder()
    .setCustomId(`ticket:move:${ticket.id}`)
    .setPlaceholder('Move to…')
    .addOptions(
      template.map((s) => ({
        label: s.label,
        value: s.key,
        default: s.key === ticket.status,
        ...(s.emoji && { emoji: s.emoji }),
      })),
    );
  return {
    embeds: [embed] as [EmbedBuilder],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(buttons),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(move),
    ] as const,
  };
}

/** One line for #activity. Mentions are rendered but the caller posts with pings disabled. */
export function activityLine(
  e: {
    key: string;
    title: string;
    type: TicketEventType;
    from?: string | null;
    to?: string | null;
    actor: string;
    /** Set for changes that came from GitHub. */
    origin?: 'github';
  },
  template: StatusSpec[],
): string {
  const ticket = `**${e.key}** ${truncate(e.title, MAX_TITLE_IN_LINE)}`;
  const actor = `<@${e.actor}>`;
  const github = e.origin === 'github';
  // Edits made in Discord (tags, names) and on GitHub do not tell the bot who made them.
  const by = github ? 'changed on GitHub' : e.actor ? actor : 'changed in Discord';
  if (github && e.type === 'created') return `🆕 ${ticket} · created on GitHub`;
  if (github && e.type === 'assigned') return `👤 ${ticket} · <@${e.to}> assigned on GitHub`;
  if (github && e.type === 'unassigned') return `👋 ${ticket} · <@${e.from}> unassigned on GitHub`;
  switch (e.type) {
    case 'created':
      return `🆕 ${ticket} · created by ${actor}`;
    case 'status': {
      const s = statusOf(template, e.to);
      return `${s?.emoji ?? '➡️'} ${ticket} → ${s?.label ?? e.to ?? '?'} · ${by}`;
    }
    case 'assigned':
      return e.to === e.actor
        ? `👤 ${ticket} · taken by ${actor}`
        : `👤 ${ticket} · ${actor} assigned <@${e.to}>`;
    case 'unassigned':
      return e.from === e.actor
        ? `👋 ${ticket} · ${actor} left`
        : `👋 ${ticket} · ${actor} unassigned <@${e.from}>`;
    case 'title':
      return `✏️ **${e.key}** renamed to ${truncate(e.to ?? '', MAX_TITLE_IN_LINE)} · ${by}`;
    case 'description':
      return `✏️ ${ticket} · description edited by ${actor}`;
    case 'deleted':
      return `🗑️ ${ticket} · deleted`;
  }
}

const ACTIONS = ['take', 'leave', 'block', 'unblock', 'move', 'blockreason'] as const;
export type TicketAction = (typeof ACTIONS)[number];

/** `ticket:<action>:<ticket id>` custom ids of buttons, the move menu and the block reason form. */
export function parseCustomId(id: string): { action: TicketAction; ticketId: number } | undefined {
  const m = /^ticket:([a-z]+):(\d+)$/.exec(id);
  const action = m?.[1] as TicketAction | undefined;
  if (!m || !action || !ACTIONS.includes(action)) return undefined;
  return { action, ticketId: Number(m[2]) };
}
