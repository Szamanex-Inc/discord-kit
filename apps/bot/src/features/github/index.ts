import { Events, MessageFlags } from 'discord.js';
import {
  ConfigError,
  DEFAULT_TEMPLATES,
  effectiveTemplates,
  featureConfig,
  GITHUB_DEFAULTS,
  githubCredentials,
} from '@discord-kit/config';
import type { Feature, FeatureContext } from '../../feature.ts';
import { canActOnProject } from '../projects/access.ts';
import { githubHooks, resetGithubHooks } from '../projects/hooks.ts';
import { profilesStore } from '../projects/profiles.ts';
import { projectsStore, type Project } from '../projects/store.ts';
import { applyTicketChange, postTicket, projectTemplate, syncPost } from '../projects/tickets.ts';
import { createGitHubClient } from './client.ts';
import { SyncEngine, type DiscordSide } from './engine.ts';
import { checkRepo } from './repos.ts';
import { githubStore } from './store.ts';

/** From the beginning of time: every open issue is imported. */
const ALL = '1970-01-01T00:00:00.000Z';
const FIRST_POLL_DELAY_MS = 10_000;

/** The running poll timers; replaced on every start (hot reload), cleared on stop. */
let timers: NodeJS.Timeout[] = [];

/** The engine's view of Discord: ticket posts, changes, #activity lines and notes in ticket posts. */
function discordSide(ctx: FeatureContext): DiscordSide {
  const projects = projectsStore(ctx.db);
  return {
    postTicket: async (project, ticket) => void (await postTicket(ctx, project, ticket)),
    applyChange: (project, ticket, event) => applyTicketChange(ctx, project, ticket, event),
    refresh: (project, ticket) => syncPost(ctx, project, ticket),
    async announce(project, text) {
      const channel = ctx.guild.channels.cache.get(project.activityId);
      if (channel?.isSendable()) await channel.send({ content: text, allowedMentions: { parse: [] } });
    },
    async note(ticket, text) {
      const thread = ticket.threadId
        ? await ctx.guild.channels.fetch(ticket.threadId).catch(() => null)
        : null;
      if (thread?.isThread() && thread.archived) await thread.setArchived(false, 'GitHub note');
      if (thread?.isSendable()) await thread.send({ content: text, allowedMentions: { parse: [] } });
      else ctx.log.warn('github', `${projects.ticket(ticket.id)?.key ?? ticket.key}: ${text}`);
    },
    async alert(project, ticket, text, pingUserId) {
      // Only the pull request's author is pinged, and only when they set their GitHub username.
      const message = {
        content: pingUserId ? `<@${pingUserId}> ${text}` : text,
        allowedMentions: pingUserId ? { users: [pingUserId] } : { parse: [] as [] },
      };
      const thread = ticket?.threadId
        ? await ctx.guild.channels.fetch(ticket.threadId).catch(() => null)
        : null;
      if (thread?.isThread()) {
        if (thread.archived) await thread.setArchived(false, 'pull request alert');
        await thread.send(message);
        return;
      }
      const channel = ctx.guild.channels.cache.get(project.activityId);
      if (channel?.isSendable()) await channel.send(message);
    },
  };
}

/**
 * GitHub: connects as a GitHub App, links project repos (install check, status labels, import
 * choice), imports issues and keeps linked tickets and issues in sync (polling every `poll_minutes`).
 * Needs GITHUB_APP_ID and the app's private key in the environment; see docs/github-app.md.
 */
export const github: Feature = {
  name: 'github',
  intents: [],

  async start(ctx) {
    const creds = githubCredentials();
    if (!creds) {
      throw new ConfigError(
        'Set GITHUB_APP_ID and GITHUB_PRIVATE_KEY (or GITHUB_PRIVATE_KEY_FILE) to use the github feature; see docs/github-app.md.',
      );
    }
    const client = createGitHubClient(creds);
    const settings = { ...GITHUB_DEFAULTS, ...featureConfig(ctx.preset, 'github') };
    const projects = projectsStore(ctx.db);
    const repos = githubStore(ctx.db);
    const templateNamed = (name: string) =>
      effectiveTemplates(featureConfig(ctx.preset, 'projects'))[name] ??
      DEFAULT_TEMPLATES[name] ??
      DEFAULT_TEMPLATES.dev!;
    const discord = discordSide(ctx);
    const engine = new SyncEngine({
      client,
      projects,
      repos,
      profiles: profilesStore(ctx.db),
      discord,
      templateFor: (project: Project) => projectTemplate(ctx, project),
      prefix: settings.label_prefix,
      log: ctx.log,
    });

    githubHooks.loginExists = (login) => client.userExists(login);
    githubHooks.checkRepo = ({ projectId, template, owner, name }) =>
      checkRepo(client, projects, projectId, owner, name, templateNamed(template), settings.label_prefix);
    githubHooks.repoAdded = (project, owner, name) => repos.addRepo(project.id, owner, name);
    githubHooks.repoRemoved = (project, owner, name) => repos.removeRepo(project.id, owner, name);
    githubHooks.ticketChanged = (project, ticket) => void engine.pushTicket(project, ticket);
    githubHooks.createIssue = (project, ticket, owner, name) =>
      engine.createIssueFor(project, ticket, owner, name);
    if (settings.issues_for_posts) {
      githubHooks.forumTicketCreated = async (project, ticket) => {
        const repo = projects.defaultRepo(project.id);
        if (!repo) return;
        const current = projects.ticket(ticket.id);
        if (!current || current.deleted) return;
        if (!current.issue) {
          try {
            await engine.createIssueFor(project, current, repo.owner, repo.name);
          } catch (e) {
            const latest = projects.ticket(ticket.id);
            if (!latest?.issue) {
              ctx.log.error('github', `could not create an issue for ${ticket.key}`, e);
              if (!latest || latest.deleted) return;
              await discord
                .note(
                  latest,
                  'Could not confirm that GitHub created the issue. Check the repo, then use `/ticket link` if the issue exists or `/ticket push` to try again.',
                )
                .catch((error: unknown) => ctx.log.warn('github', `could not notify ${ticket.key}`, error));
              return;
            }
          }
        }
        const linked = projects.ticket(ticket.id);
        if (linked && !linked.deleted) {
          await discord
            .refresh(project, linked)
            .catch((e: unknown) =>
              ctx.log.warn('github', `could not refresh the linked issue in ${ticket.key}`, e),
            );
        }
      };
    }
    githubHooks.linkIssue = (project, ticket, ref) => engine.linkExisting(project, ticket, ref);
    githubHooks.sync = (projectId) => engine.poll(projectId);

    // Polling: one run shortly after start, then every poll_minutes; a run never overlaps the previous one.
    let running: Promise<unknown> | undefined;
    const tick = () => {
      running ??= engine
        .poll()
        .catch((e: unknown) => ctx.log.error('github', 'sync failed', e))
        .finally(() => (running = undefined));
    };
    for (const timer of timers) clearTimeout(timer);
    timers = [setTimeout(tick, FIRST_POLL_DELAY_MS), setInterval(tick, settings.poll_minutes * 60_000)];

    // The import choice offered when a repo is added: ghimport:<all|new>:<github repo id>.
    ctx.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isButton() || !interaction.inCachedGuild()) return;
      const m = /^ghimport:(all|new):(\d+)$/.exec(interaction.customId);
      if (!m) return;
      const repo = repos.repo(Number(m[2]));
      const project = repo ? projects.project(repo.projectId) : undefined;
      if (!repo || !project) {
        await interaction.reply({ content: 'That repo is no longer linked.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (!canActOnProject(interaction.member, project, ctx.preset)) {
        await interaction.reply({
          content: `Only members of **${project.name}** can choose.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const all = m[1] === 'all';
      repos.setSyncFrom(repo.id, all ? ALL : new Date().toISOString());
      await interaction.update({
        content: all
          ? `Importing the open issues of \`${repo.owner}/${repo.name}\`; a summary will appear in <#${project.activityId}>.`
          : `\`${repo.owner}/${repo.name}\`: new issues will become tickets from now on.`,
        components: [],
      });
      if (all) {
        void engine
          .importRepo(repo.id)
          .catch((e: unknown) => ctx.log.error('github', `import of ${repo.owner}/${repo.name} failed`, e));
      }
    });
  },

  async stop() {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
    resetGithubHooks();
  },
};
