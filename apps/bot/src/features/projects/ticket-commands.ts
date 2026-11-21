import { createHash } from 'node:crypto';
import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { StatusSpec } from '@discord-kit/config';
import type { FeatureCommand, FeatureContext } from '../../feature.ts';
import { canActOnProject } from './access.ts';
import { githubHooks } from './hooks.ts';
import { parseIssueRef, parseRepos } from './keys.ts';
import { resolveProject } from './project-commands.ts';
import { parseCustomId, statusLabel } from './render.ts';
import { projectsStore, type Project, type Ticket, type ProjectsStore } from './store.ts';
import { announce, applyTicketChange, postTicket, projectTemplate, syncPost } from './tickets.ts';

type Interaction = ChatInputCommandInteraction<'cached'>;
const MAX_LIST = 25;
const EDIT_TITLE_LIMIT = 256;
const EDIT_BODY_LIMIT = 4000;
const EDIT_MODAL = /^ticket:edit:(\d+):([\w-]{43})$/;

function command() {
  const ticketOption = (o: import('discord.js').SlashCommandStringOption) =>
    o.setName('ticket').setDescription('Ticket key, e.g. DK-12 (default: the ticket of this post)');
  return new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Create and update tickets')
    .addSubcommand((s) =>
      s
        .setName('new')
        .setDescription('Create a ticket')
        .addStringOption((o) => o.setName('title').setDescription('Title').setRequired(true).setMaxLength(90))
        .addStringOption((o) => o.setName('description').setDescription('Details').setMaxLength(2000))
        .addStringOption((o) =>
          o.setName('project').setDescription('Project key (default: this channel’s project)'),
        )
        .addStringOption((o) =>
          o
            .setName('repo')
            .setDescription('GitHub repo for the issue, owner/name, or "none" (default: the default repo)'),
        ),
    )
    .addSubcommand((s) =>
      s.setName('edit').setDescription('Edit a ticket’s title and description').addStringOption(ticketOption),
    )
    .addSubcommand((s) =>
      s
        .setName('move')
        .setDescription('Change the status of a ticket')
        .addStringOption((o) => o.setName('status').setDescription('Status name or key').setRequired(true))
        .addStringOption(ticketOption),
    )
    .addSubcommand((s) =>
      s
        .setName('assign')
        .setDescription('Assign someone to a ticket')
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
        .addStringOption(ticketOption),
    )
    .addSubcommand((s) =>
      s
        .setName('unassign')
        .setDescription('Remove someone from a ticket')
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
        .addStringOption(ticketOption),
    )
    .addSubcommand((s) =>
      s
        .setName('list')
        .setDescription('Tickets of a project')
        .addStringOption((o) => o.setName('status').setDescription('Only this status'))
        .addUserOption((o) => o.setName('assignee').setDescription('Only tickets of this member'))
        .addStringOption((o) =>
          o.setName('project').setDescription('Project key (default: this channel’s project)'),
        ),
    )
    .addSubcommand((s) => s.setName('mine').setDescription('Tickets assigned to you in all projects'))
    .addSubcommand((s) =>
      s
        .setName('link')
        .setDescription('Link a ticket to an existing GitHub issue (the issue wins)')
        .addStringOption((o) =>
          o.setName('issue').setDescription('owner/name#42 or the issue URL').setRequired(true),
        )
        .addStringOption(ticketOption),
    )
    .addSubcommand((s) =>
      s
        .setName('push')
        .setDescription('Create a GitHub issue for a ticket that has none')
        .addStringOption((o) => o.setName('repo').setDescription('owner/name (default: the default repo)'))
        .addStringOption(ticketOption),
    )
    .toJSON();
}

/** A status by key or label, case-insensitive. */
export function findStatus(template: StatusSpec[], input: string): StatusSpec | undefined {
  const needle = input.trim().toLowerCase();
  return template.find((s) => s.key === needle || s.label.toLowerCase() === needle);
}

function resolveTicket(interaction: Interaction, store: ProjectsStore): Ticket | undefined {
  const key = interaction.options.getString('ticket');
  if (key) return store.ticketByKey(key);
  return interaction.channel?.isThread() ? store.ticketByThread(interaction.channel.id) : undefined;
}

const line = (t: Ticket, template: StatusSpec[]) =>
  `**${t.key}** ${t.title} · ${statusLabel(template, t.status)}${t.assignees.length ? ` · ${t.assignees.map((id) => `<@${id}>`).join(', ')}` : ''}`;

function listLines(lines: string[], empty: string): string {
  if (!lines.length) return empty;
  const shown = lines.slice(0, MAX_LIST);
  return shown.join('\n') + (lines.length > MAX_LIST ? `\n… ${lines.length - MAX_LIST} more` : '');
}

async function run(interaction: Interaction, ctx: FeatureContext): Promise<string> {
  const store = projectsStore(ctx.db);
  const sub = interaction.options.getSubcommand();

  if (sub === 'mine') {
    const lines = store.ticketsAssignedTo(interaction.user.id).map((t) => {
      const project = store.project(t.projectId)!;
      return line(t, projectTemplate(ctx, project));
    });
    return listLines(lines, 'You have no tickets. Take one with the **Take** button in a ticket post.');
  }

  if (sub === 'new' || sub === 'list') {
    const project = resolveProject(interaction, store);
    if (!project) return 'Run this in a project channel or pass `project:` with its key.';
    const template = projectTemplate(ctx, project);
    if (sub === 'list') {
      const statusInput = interaction.options.getString('status');
      const status = statusInput ? findStatus(template, statusInput) : undefined;
      if (statusInput && !status)
        return `No status \`${statusInput}\`. Statuses: ${template.map((s) => s.label).join(', ')}.`;
      const tickets = store.tickets(project.id, {
        ...(status && { status: status.key }),
        ...(interaction.options.getUser('assignee') && {
          assignee: interaction.options.getUser('assignee')!.id,
        }),
      });
      return listLines(
        tickets.map((t) => line(t, template)),
        'No tickets match.',
      );
    }
    if (!canActOnProject(interaction.member, project, ctx.preset)) return notMember(project);
    const ticket = store.createTicket(
      project.id,
      {
        title: interaction.options.getString('title', true).trim(),
        body: interaction.options.getString('description')?.trim() ?? '',
        status: template[0]!.key,
        createdBy: interaction.user.id,
      },
      'command',
    );
    const thread = await postTicket(ctx, project, ticket);
    await announce(ctx, project, ticket, { type: 'created', to: ticket.status, actor: interaction.user.id });
    const issue = await issueForNewTicket(interaction, ctx, project, ticket);
    return `Created **${ticket.key}**: ${thread.toString()}${issue}`;
  }

  const ticket = resolveTicket(interaction, store);
  if (!ticket || ticket.deleted)
    return 'Run this in a ticket post or pass `ticket:` with its key, e.g. `DK-12`.';
  const project = store.project(ticket.projectId)!;
  if (!canActOnProject(interaction.member, project, ctx.preset)) return notMember(project);
  const actor = interaction.user.id;

  if (sub === 'link' || sub === 'push') return linkOrPush(interaction, ctx, project, ticket, sub);

  if (sub === 'move') {
    const template = projectTemplate(ctx, project);
    const input = interaction.options.getString('status', true);
    const status = findStatus(template, input);
    if (!status) return `No status \`${input}\`. Statuses: ${template.map((s) => s.label).join(', ')}.`;
    const updated = store.setStatus(ticket.id, status.key, actor, 'command');
    if (!updated) return `**${ticket.key}** is already ${status.label}.`;
    await applyTicketChange(ctx, project, updated, {
      type: 'status',
      from: ticket.status,
      to: status.key,
      actor,
    });
    return `Moved **${ticket.key}** to ${status.label}.`;
  }

  const user = interaction.options.getUser('user', true);
  const assign = sub === 'assign';
  const changed = assign
    ? store.addAssignee(ticket.id, user.id, actor, 'command')
    : store.removeAssignee(ticket.id, user.id, actor, 'command');
  if (!changed)
    return assign
      ? `${user.toString()} already has **${ticket.key}**.`
      : `${user.toString()} is not on **${ticket.key}**.`;
  await applyTicketChange(ctx, project, store.ticket(ticket.id)!, {
    type: assign ? 'assigned' : 'unassigned',
    ...(assign ? { to: user.id } : { from: user.id }),
    actor,
  });
  return assign
    ? `Assigned ${user.toString()} to **${ticket.key}**.`
    : `Removed ${user.toString()} from **${ticket.key}**.`;
}

const notMember = (project: Project) =>
  `Only members of **${project.name}** can change its tickets. Ask for \`/project member add\`.`;

export function ticketCommand(): FeatureCommand {
  return {
    data: command(),
    async execute(interaction, ctx) {
      if (interaction.options.getSubcommand() === 'edit') {
        await showTicketEdit(interaction, ctx);
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const content = await run(interaction, ctx);
      await interaction.editReply({ content, allowedMentions: { parse: [] } });
    },
  };
}

function detailsRevision(ticket: Ticket): string {
  return createHash('sha256')
    .update(JSON.stringify([ticket.title, ticket.body]))
    .digest('base64url');
}

async function showTicketEdit(interaction: Interaction, ctx: FeatureContext): Promise<void> {
  const store = projectsStore(ctx.db);
  const ticket = resolveTicket(interaction, store);
  const reply = (content: string) =>
    interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  if (!ticket || ticket.deleted) {
    await reply('Run this in a ticket post or pass `ticket:` with its key, e.g. `DK-12`.');
    return;
  }
  const project = store.project(ticket.projectId)!;
  if (!canActOnProject(interaction.member, project, ctx.preset)) {
    await reply(notMember(project));
    return;
  }

  const title = new TextInputBuilder()
    .setCustomId('title')
    .setLabel('Title')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(EDIT_TITLE_LIMIT)
    .setRequired(true);
  if (ticket.title) title.setValue(ticket.title.slice(0, EDIT_TITLE_LIMIT));
  const body = new TextInputBuilder()
    .setCustomId('description')
    .setLabel('Description (Discord only)')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(EDIT_BODY_LIMIT)
    .setRequired(false);
  if (ticket.body) body.setValue(ticket.body.slice(0, EDIT_BODY_LIMIT));

  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(`ticket:edit:${ticket.id}:${detailsRevision(ticket)}`)
      .setTitle(`Edit ${ticket.key}`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(title),
        new ActionRowBuilder<TextInputBuilder>().addComponents(body),
      ),
  );
}

/** Keeps a long imported value intact if its visible portion was left alone in the form. */
function editedValue(input: string, original: string, limit: number): string {
  return input === original.slice(0, limit) ? original : input.trim();
}

/** Saves a ticket edit submitted from its slash command form. */
export async function handleTicketEdit(
  interaction: ModalSubmitInteraction<'cached'>,
  ctx: FeatureContext,
): Promise<boolean> {
  const match = EDIT_MODAL.exec(interaction.customId);
  if (!match) return false;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const store = projectsStore(ctx.db);
  const ticket = store.ticket(Number(match[1]));
  if (!ticket || ticket.deleted) {
    await interaction.editReply('This ticket no longer exists.');
    return true;
  }
  const project = store.project(ticket.projectId)!;
  if (!canActOnProject(interaction.member, project, ctx.preset)) {
    await interaction.editReply({ content: notMember(project), allowedMentions: { parse: [] } });
    return true;
  }
  if (detailsRevision(ticket) !== match[2]) {
    await interaction.editReply('The ticket was edited while this form was open. Run `/ticket edit` again.');
    return true;
  }
  const title = editedValue(interaction.fields.getTextInputValue('title'), ticket.title, EDIT_TITLE_LIMIT);
  const body = editedValue(interaction.fields.getTextInputValue('description'), ticket.body, EDIT_BODY_LIMIT);
  if (!title.trim()) {
    await interaction.editReply('Enter a title with at least one non-space character.');
    return true;
  }

  const actor = interaction.user.id;
  const updated = store.editTicket(ticket.id, title, body, actor);
  if (!updated) {
    await interaction.editReply(`No changes to **${ticket.key}**.`);
    return true;
  }
  const description = { type: 'description', actor } as const;
  if (title !== ticket.title) {
    await applyTicketChange(ctx, project, updated, { type: 'title', from: ticket.title, to: title, actor });
    if (body !== ticket.body) await announce(ctx, project, updated, description);
  } else {
    await applyTicketChange(ctx, project, updated, description);
  }
  await interaction.editReply(`Updated **${ticket.key}**.`);
  return true;
}

type ComponentInteraction =
  ButtonInteraction<'cached'> | StringSelectMenuInteraction<'cached'> | ModalSubmitInteraction<'cached'>;

/**
 * Buttons, the move menu and the block reason form of ticket posts. Returns false when the
 * interaction is not one of them. Everything is acknowledged first, except Blocked, whose first
 * response must be the form.
 */
export async function handleTicketComponent(
  interaction: ComponentInteraction,
  ctx: FeatureContext,
): Promise<boolean> {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return false;
  const store = projectsStore(ctx.db);
  const ticket = store.ticket(parsed.ticketId);
  const refuse = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  if (!ticket || ticket.deleted) return (void (await refuse('This ticket no longer exists.')), true);
  const project = store.project(ticket.projectId)!;
  if (!canActOnProject(interaction.member, project, ctx.preset))
    return (void (await refuse(notMember(project))), true);
  const template = projectTemplate(ctx, project);
  const blocked = template.find((s) => s.blocked);
  const actor = interaction.user.id;

  if (parsed.action === 'block' && interaction.isButton()) {
    const reason = new TextInputBuilder()
      .setCustomId('reason')
      .setLabel('What is blocking it?')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(500);
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(`ticket:blockreason:${ticket.id}`)
        .setTitle(`Block ${ticket.key}`)
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(reason)),
    );
    return true;
  }

  await interaction.deferUpdate();
  const followUp = (content: string) =>
    interaction.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

  if (parsed.action === 'take' || parsed.action === 'leave') {
    const take = parsed.action === 'take';
    const changed = take
      ? store.addAssignee(ticket.id, actor, actor, 'button')
      : store.removeAssignee(ticket.id, actor, actor, 'button');
    if (!changed)
      return (
        void (await followUp(take ? 'You already have this ticket.' : 'You are not on this ticket.')),
        true
      );
    await applyTicketChange(ctx, project, store.ticket(ticket.id)!, {
      type: take ? 'assigned' : 'unassigned',
      ...(take ? { to: actor } : { from: actor }),
      actor,
    });
    return true;
  }

  let target: string | undefined;
  if (parsed.action === 'move' && interaction.isStringSelectMenu()) target = interaction.values[0];
  else if (parsed.action === 'unblock' && blocked)
    target = store.statusBefore(ticket.id, blocked.key) ?? template[0]!.key;
  else if (parsed.action === 'blockreason' && interaction.isModalSubmit() && blocked) {
    target = blocked.key;
    const reason = interaction.fields.getTextInputValue('reason');
    const thread = ticket.threadId ? await ctx.guild.channels.fetch(ticket.threadId).catch(() => null) : null;
    if (thread?.isSendable()) {
      await thread.send({
        content: `${blocked.emoji ?? '⛔'} Blocked by <@${actor}>: ${reason}`,
        allowedMentions: { parse: [] },
      });
    }
  }
  if (!target) return true;
  const updated = store.setStatus(ticket.id, target, actor, 'button');
  if (updated)
    await applyTicketChange(ctx, project, updated, {
      type: 'status',
      from: ticket.status,
      to: target,
      actor,
    });
  return true;
}

type RepoPick = { owner: string; name: string } | { none: true } | { error: string };

/** The repo for an issue: the `repo` option (owner/name or "none"), else the project's default repo. */
function pickRepo(input: string | null, store: ProjectsStore, project: Project): RepoPick {
  if (input?.trim().toLowerCase() === 'none') return { none: true };
  if (!input) {
    const repo = store.defaultRepo(project.id);
    return repo ? { owner: repo.owner, name: repo.name } : { none: true };
  }
  let parsed: { owner: string; name: string } | undefined;
  try {
    parsed = parseRepos(input)[0];
  } catch (e) {
    return { error: (e as Error).message };
  }
  const match =
    parsed &&
    store
      .repos(project.id)
      .find(
        (r) =>
          r.owner.toLowerCase() === parsed.owner.toLowerCase() &&
          r.name.toLowerCase() === parsed.name.toLowerCase(),
      );
  return match
    ? { owner: match.owner, name: match.name }
    : { error: `\`${input}\` is not a repo of **${project.name}**.` };
}

/** With GitHub connected and a repo to use, creates the new ticket's issue. Returns a line for the reply. */
async function issueForNewTicket(
  interaction: Interaction,
  ctx: FeatureContext,
  project: Project,
  ticket: Ticket,
): Promise<string> {
  if (!githubHooks.createIssue) return '';
  const store = projectsStore(ctx.db);
  const pick = pickRepo(interaction.options.getString('repo'), store, project);
  if ('none' in pick) return '';
  if ('error' in pick) return `\nNo GitHub issue: ${pick.error}`;
  try {
    const number = await githubHooks.createIssue(project, ticket, pick.owner, pick.name);
    await syncPost(ctx, project, store.ticket(ticket.id)!);
    return ` · issue ${pick.owner}/${pick.name}#${number}`;
  } catch (e) {
    ctx.log.error('projects', `could not create the GitHub issue for ${ticket.key}`, e);
    return `\nCould not create the GitHub issue: ${(e as Error).message}`;
  }
}

/** /ticket link (to an existing issue) and /ticket push (create the issue). */
async function linkOrPush(
  interaction: Interaction,
  ctx: FeatureContext,
  project: Project,
  ticket: Ticket,
  sub: string,
): Promise<string> {
  if (!githubHooks.linkIssue || !githubHooks.createIssue)
    return 'GitHub is not connected (the github feature is off).';
  const store = projectsStore(ctx.db);
  if (sub === 'link') {
    const ref = parseIssueRef(interaction.options.getString('issue', true));
    if (!ref) return 'Pass the issue as `owner/name#42` or its URL.';
    const error = await githubHooks.linkIssue(project, ticket, ref);
    if (error) return error;
    await syncPost(ctx, project, store.ticket(ticket.id)!);
    return `Linked **${ticket.key}** to ${ref.owner}/${ref.name}#${ref.number}; the issue's status and title now apply.`;
  }
  const linked = ticket.issue;
  if (linked)
    return `**${ticket.key}** is already linked to ${linked.owner}/${linked.name}#${linked.number}.`;
  const pick = pickRepo(interaction.options.getString('repo'), store, project);
  if ('error' in pick) return pick.error;
  if ('none' in pick) return `**${project.name}** has no repos; add one with \`/project repo add\`.`;
  const number = await githubHooks.createIssue(project, ticket, pick.owner, pick.name);
  await syncPost(ctx, project, store.ticket(ticket.id)!);
  return `Created ${pick.owner}/${pick.name}#${number} for **${ticket.key}**.`;
}
