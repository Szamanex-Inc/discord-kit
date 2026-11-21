import { Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import type { Feature } from '../../feature.ts';
import { Debouncer } from './board.ts';
import { redrawBoard } from './board-channel.ts';
import { registerPost, shouldRegisterPost } from './intake.ts';
import { projectCommand } from './project-commands.ts';
import { onMessageDelete, onThreadDelete, onThreadUpdate, reconcileProject } from './reconcile-discord.ts';
import { projectsStore } from './store.ts';
import { handleProfileModal, profileCommand } from './profile-command.ts';
import { handleTicketComponent, handleTicketEdit, ticketCommand } from './ticket-commands.ts';
import { boardHooks, resetTemplateWarnings } from './tickets.ts';

const BOARD_DELAY_MS = 3000;
/** The running board debouncer; replaced on every start (hot reload), stopped on stop. */
let board: Debouncer | undefined;

/**
 * Projects: `/project create` gives a project its own role, category, #tickets forum (status tags),
 * #board and #activity. `/ticket` and the controls in each ticket post change tickets; every change
 * is stored with its history and posted to #activity.
 */
export const projects: Feature = {
  name: 'projects',
  // Message Content (privileged) lets the bot read the text of ticket posts made by hand.
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  commands: (preset) => [projectCommand(preset), ticketCommand(), profileCommand()],

  async start(ctx) {
    // Runs the module's migrations before any command uses the store.
    const store = projectsStore(ctx.db);
    resetTemplateWarnings();

    // Board redraws: at most one per project every few seconds, however many tickets change.
    board?.stop();
    const debouncer = new Debouncer(
      (projectId) =>
        redrawBoard(ctx, projectId).catch((e: unknown) =>
          ctx.log.error('projects', `could not redraw the board of project ${projectId}`, e),
        ),
      BOARD_DELAY_MS,
    );
    board = debouncer;
    boardHooks.changed = (projectId) => debouncer.schedule(projectId);
    for (const project of store.projects()) debouncer.schedule(project.id);

    // Hand edits: tags, names, deleted posts, deleted control or board messages.
    const logError = (what: string) => (e: unknown) => ctx.log.error('projects', what, e);
    ctx.on(Events.ThreadUpdate, async (before, after) => {
      await onThreadUpdate(ctx, before, after).catch(
        logError(`could not reconcile an edit of "${after.name}"`),
      );
    });
    ctx.on(Events.ThreadDelete, async (thread) => {
      await onThreadDelete(ctx, thread).catch(logError(`could not handle the deletion of "${thread.name}"`));
    });
    ctx.on(Events.MessageDelete, async (message) => {
      await onMessageDelete(ctx, message.id, message.channelId).catch(
        logError('could not handle a deleted message'),
      );
    });

    // Changes made while the bot was offline. In the background, so start() returns at once.
    void (async () => {
      for (const project of store.projects()) {
        await reconcileProject(ctx, project, { thorough: false }).catch(
          logError(`could not reconcile ${project.key}`),
        );
      }
    })();

    // Posts made by hand in a project's #tickets become tickets.
    ctx.on(Events.ThreadCreate, async (thread, newlyCreated) => {
      if (!newlyCreated || !thread.parentId) return;
      const project = store.projectByChannel(thread.parentId);
      if (project?.forumId !== thread.parentId) return;
      const tracked = Boolean(store.ticketByThread(thread.id));
      if (!shouldRegisterPost(thread, ctx.client.user.id, new Set([project.forumId]), tracked)) return;
      await registerPost(ctx, project, thread).catch((e: unknown) =>
        ctx.log.error('projects', `could not turn post "${thread.name}" into a ticket`, e),
      );
    });

    ctx.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.inCachedGuild()) return;
      if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit())
        return;
      try {
        if (interaction.isModalSubmit() && (await handleProfileModal(interaction, ctx))) return;
        if (interaction.isModalSubmit() && (await handleTicketEdit(interaction, ctx))) return;
        await handleTicketComponent(interaction, ctx);
      } catch (e) {
        ctx.log.error('projects', `ticket control ${interaction.customId} failed`, e);
        const reply = { content: 'Something went wrong.', flags: MessageFlags.Ephemeral } as const;
        if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
        else await interaction.reply(reply).catch(() => {});
      }
    });
  },

  async stop() {
    board?.stop();
    board = undefined;
    boardHooks.changed = () => {};
  },
};
