import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  GuildFeature,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import {
  effectiveTemplates,
  featureConfig,
  PROJECT_DEFAULTS,
  type Preset,
  type ProjectsSpec,
} from '@discord-kit/config';
import type { FeatureCommand, FeatureContext } from '../../feature.ts';
import { canActOnProject, canCreateProjects, isAdmin } from './access.ts';
import { createProjectChannels } from './channels.ts';
import { githubHooks } from './hooks.ts';
import { deriveKey, isValidKey, parseRepos, roleName } from './keys.ts';
import { rebuildBoard } from './board-channel.ts';
import { isValidLinkUrl, MAX_LINKS } from './links.ts';
import { reconcileProject } from './reconcile-discord.ts';
import { projectsStore, type Project, type ProjectsStore } from './store.ts';
import { boardHooks } from './tickets.ts';

type Interaction = ChatInputCommandInteraction<'cached'>;

const settings = (preset: Preset): ProjectsSpec => featureConfig(preset, 'projects') ?? {};

function command(preset: Preset) {
  const templates = Object.keys(effectiveTemplates(settings(preset))).slice(0, 25);
  const projectOption = (o: import('discord.js').SlashCommandStringOption) =>
    o.setName('project').setDescription('Project key, e.g. DK (default: the project of this channel)');
  return new SlashCommandBuilder()
    .setName('project')
    .setDescription('Create and manage projects')
    .addSubcommand((s) =>
      s
        .setName('create')
        .setDescription('Create a project with its own category, ticket forum and board')
        .addStringOption((o) =>
          o.setName('name').setDescription('Project name').setRequired(true).setMaxLength(50),
        )
        .addStringOption((o) =>
          o
            .setName('key')
            .setDescription('Ticket key prefix, 2–6 letters (default: from the name)')
            .setMaxLength(6),
        )
        .addStringOption((o) =>
          o
            .setName('template')
            .setDescription('Status template')
            .addChoices(...templates.map((t) => ({ name: t, value: t }))),
        )
        .addStringOption((o) =>
          o
            .setName('visibility')
            .setDescription('Who can see the project')
            .addChoices(
              { name: 'private (project members)', value: 'private' },
              { name: 'public (all members)', value: 'public' },
            ),
        )
        .addStringOption((o) =>
          o.setName('repos').setDescription('GitHub repos as owner/name (or URLs), separated by spaces'),
        ),
    )
    .addSubcommand((s) => s.setName('list').setDescription('All projects'))
    .addSubcommand((s) =>
      s
        .setName('sync')
        .setDescription('Check GitHub for changes now')
        .addStringOption(projectOption)
        .addBooleanOption((o) => o.setName('all').setDescription('All projects')),
    )
    .addSubcommand((s) =>
      s
        .setName('refresh')
        .setDescription('Re-check a project against Discord: tags, posts, board')
        .addStringOption(projectOption)
        .addBooleanOption((o) =>
          o
            .setName('board')
            .setDescription('Also re-post the board messages in status order (creator or admin)'),
        ),
    )
    .addSubcommand((s) =>
      s.setName('join').setDescription('Join a public project').addStringOption(projectOption),
    )
    .addSubcommand((s) => s.setName('leave').setDescription('Leave a project').addStringOption(projectOption))
    .addSubcommandGroup((g) =>
      g
        .setName('member')
        .setDescription('Project members')
        .addSubcommand((s) =>
          s
            .setName('add')
            .setDescription('Add a member to a project')
            .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
            .addStringOption(projectOption),
        )
        .addSubcommand((s) =>
          s
            .setName('remove')
            .setDescription('Remove a member from a project')
            .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
            .addStringOption(projectOption),
        ),
    )
    .addSubcommandGroup((g) =>
      g
        .setName('repo')
        .setDescription('GitHub repos of a project')
        .addSubcommand((s) =>
          s
            .setName('add')
            .setDescription('Add a repo')
            .addStringOption((o) => o.setName('repo').setDescription('owner/name').setRequired(true))
            .addStringOption(projectOption),
        )
        .addSubcommand((s) =>
          s
            .setName('remove')
            .setDescription('Remove a repo')
            .addStringOption((o) => o.setName('repo').setDescription('owner/name').setRequired(true))
            .addStringOption(projectOption),
        )
        .addSubcommand((s) =>
          s
            .setName('default')
            .setDescription('Make a repo the default for new tickets')
            .addStringOption((o) => o.setName('repo').setDescription('owner/name').setRequired(true))
            .addStringOption(projectOption),
        ),
    )
    .addSubcommandGroup((g) =>
      g
        .setName('link')
        .setDescription('Links of a project: designs, boards, docs, anything')
        .addSubcommand((s) =>
          s
            .setName('add')
            .setDescription('Add a link, e.g. name: Figma, url: https://figma.com/…')
            .addStringOption((o) =>
              o
                .setName('name')
                .setDescription('What it is, e.g. Figma or Roadmap')
                .setRequired(true)
                .setMaxLength(50),
            )
            .addStringOption((o) => o.setName('url').setDescription('https://…').setRequired(true))
            .addStringOption(projectOption),
        )
        .addSubcommand((s) =>
          s
            .setName('remove')
            .setDescription('Remove a link')
            .addStringOption((o) => o.setName('name').setDescription('Name of the link').setRequired(true))
            .addStringOption(projectOption),
        ),
    )
    .toJSON();
}

/**
 * The project named by the `project` option, or the project of the channel the command runs in
 * (its category, forum, board or activity channel, or a ticket post in its forum).
 */
export function resolveProject(interaction: Interaction, store: ProjectsStore): Project | undefined {
  const key = interaction.options.getString('project');
  if (key) return store.projectByKey(key);
  const channel = interaction.channel;
  if (!channel) return undefined;
  const parent = 'parent' in channel ? channel.parent : null;
  for (const id of [channel.id, parent?.id, parent && 'parentId' in parent ? parent.parentId : null]) {
    const project = id ? store.projectByChannel(id) : undefined;
    if (project) return project;
  }
  return undefined;
}

const NO_PROJECT = 'Run this in a project channel or pass `project:` with its key.';

async function create(interaction: Interaction, ctx: FeatureContext): Promise<Reply> {
  const cfg = settings(ctx.preset);
  if (!canCreateProjects(interaction.member, ctx.preset, cfg.creator_roles)) {
    return 'You cannot create projects.';
  }
  if (!interaction.guild.features.includes(GuildFeature.Community)) {
    return 'Projects need forum channels, which need Community mode: Server Settings → Enable Community.';
  }
  const store = projectsStore(ctx.db);
  const name = interaction.options.getString('name', true).trim();
  const key = (interaction.options.getString('key') ?? deriveKey(name)).toUpperCase();
  if (!isValidKey(key)) return `\`${key}\` is not a valid key: use 2–6 letters, e.g. \`key:DEMO\`.`;
  const taken = store.projectByKey(key);
  if (taken) return `The key \`${key}\` is already used by **${taken.name}**. Pass another \`key:\`.`;
  const templateName =
    interaction.options.getString('template') ?? cfg.default_template ?? PROJECT_DEFAULTS.default_template;
  const template = effectiveTemplates(cfg)[templateName];
  if (!template) return `There is no template \`${templateName}\`.`;
  const visibility = (interaction.options.getString('visibility') ??
    cfg.default_visibility ??
    PROJECT_DEFAULTS.default_visibility) as 'private' | 'public';
  let repos: { owner: string; name: string }[];
  try {
    repos = parseRepos(interaction.options.getString('repos') ?? '');
  } catch (e) {
    return (e as Error).message;
  }
  // Every repo is checked before anything is created, so a bad repo creates nothing.
  if (githubHooks.checkRepo && repos.length > MAX_ROWS) {
    return `Add at most ${MAX_ROWS} repos with /project create; add more later with /project repo add.`;
  }
  const checks = new Map<string, number>();
  for (const r of repos) {
    const other = store.projectByRepo(r.owner, r.name);
    if (other)
      return `\`${r.owner}/${r.name}\` already belongs to **${other.name}**; a repo can be in one project.`;
    if (!githubHooks.checkRepo) continue;
    const check = await githubHooks.checkRepo({ template: templateName, owner: r.owner, name: r.name });
    if (!check.ok) return check.reason;
    checks.set(`${r.owner}/${r.name}`, check.openIssues);
  }

  const memberRoleIds = ctx.preset.memberRoles
    .map((n) => interaction.guild.roles.cache.find((r) => r.name === n)?.id)
    .filter((id): id is string => Boolean(id));
  const channels = await createProjectChannels(interaction.guild, ctx.client.user.id, {
    name,
    template,
    visibility,
    roleName: roleName(cfg.role_format ?? PROJECT_DEFAULTS.role_format, name),
    memberRoleIds,
  });
  const project = store.createProject({
    key,
    name,
    template: templateName,
    visibility,
    createdBy: interaction.user.id,
    ...channels,
  });
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (const r of repos) {
    store.addRepo(project.id, r.owner, r.name);
    const openIssues = checks.get(`${r.owner}/${r.name}`);
    if (openIssues !== undefined && githubHooks.repoAdded) {
      rows.push(
        importButtons(githubHooks.repoAdded(project, r.owner, r.name), `${r.owner}/${r.name}`, openIssues),
      );
    }
  }
  await interaction.member.roles.add(channels.roleId, `created project ${name}`);
  ctx.log.info('projects', `${interaction.user.tag} created project ${key} (${name})`);
  const content = `Created **${name}** (\`${key}\`, ${templateName}, ${visibility}). Tickets go in <#${channels.forumId}>.`;
  return rows.length
    ? { content: `${content}\nImport the open issues of each repo?`, components: rows }
    : content;
}

/** Discord allows five rows of buttons per message: one row per repo. */
const MAX_ROWS = 5;

type Reply = string | { content: string; components: ActionRowBuilder<ButtonBuilder>[] };

/** The import choice for a linked repo; the github feature handles the clicks. */
function importButtons(repoId: number, label: string, openIssues: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`ghimport:all:${repoId}`)
      .setLabel(`${label}: import ${openIssues} open issue${openIssues === 1 ? '' : 's'}`.slice(0, 80))
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`ghimport:new:${repoId}`)
      .setLabel('Only new issues')
      .setStyle(ButtonStyle.Secondary),
  );
}

function list(ctx: FeatureContext): string {
  const store = projectsStore(ctx.db);
  const lines = store.projects().map((p) => {
    const repos = store.repos(p.id).map((r) => `${r.owner}/${r.name}${r.isDefault ? ' (default)' : ''}`);
    const linkCount = store.links(p.id).length;
    return `**${p.key}** ${p.name} · ${p.visibility} · <#${p.forumId}>${repos.length ? ` · ${repos.join(', ')}` : ''}${linkCount ? ` · ${linkCount} link(s)` : ''}`;
  });
  return lines.join('\n') || 'No projects yet. Create one with `/project create`.';
}

const canManage = (interaction: Interaction, project: Project, ctx: FeatureContext) =>
  project.createdBy === interaction.user.id || isAdmin(interaction.member, ctx.preset);

async function membership(interaction: Interaction, ctx: FeatureContext, project: Project, sub: string) {
  if (sub === 'join' || sub === 'leave') {
    if (sub === 'join' && project.visibility !== 'public') {
      return `**${project.name}** is private; ask its creator or an admin to add you.`;
    }
    if (sub === 'join') await interaction.member.roles.add(project.roleId, `joined project ${project.key}`);
    else await interaction.member.roles.remove(project.roleId, `left project ${project.key}`);
    return sub === 'join' ? `You joined **${project.name}**.` : `You left **${project.name}**.`;
  }
  if (!canManage(interaction, project, ctx))
    return 'Only the project creator or an admin can manage members.';
  const user = interaction.options.getMember('user');
  if (!user) return 'That user is not on this server.';
  if (sub === 'add')
    await user.roles.add(project.roleId, `added to project ${project.key} by ${interaction.user.tag}`);
  else
    await user.roles.remove(project.roleId, `removed from project ${project.key} by ${interaction.user.tag}`);
  return sub === 'add'
    ? `Added ${user.toString()} to **${project.name}**.`
    : `Removed ${user.toString()} from **${project.name}**.`;
}

async function repos(
  interaction: Interaction,
  ctx: FeatureContext,
  project: Project,
  sub: string,
): Promise<Reply> {
  if (!canManage(interaction, project, ctx)) return 'Only the project creator or an admin can manage repos.';
  let repo: { owner: string; name: string } | undefined;
  try {
    repo = parseRepos(interaction.options.getString('repo', true))[0];
  } catch (e) {
    return (e as Error).message;
  }
  if (!repo) return 'Pass a repo as owner/name.';
  const store = projectsStore(ctx.db);
  const label = `${repo.owner}/${repo.name}`;
  if (sub === 'add') {
    const other = store.projectByRepo(repo.owner, repo.name);
    if (other && other.id !== project.id) {
      return `\`${label}\` already belongs to **${other.name}**; a repo can be in one project.`;
    }
    const check = githubHooks.checkRepo
      ? await githubHooks.checkRepo({
          projectId: project.id,
          template: project.template,
          owner: repo.owner,
          name: repo.name,
        })
      : undefined;
    if (check && !check.ok) return check.reason;
    store.addRepo(project.id, repo.owner, repo.name);
    boardHooks.changed(project.id);
    const added = `Added \`${label}\` to **${project.name}**.`;
    if (!check?.ok || !githubHooks.repoAdded) return added;
    const repoId = githubHooks.repoAdded(project, repo.owner, repo.name);
    return {
      content: `${added} Import its open issues?`,
      components: [importButtons(repoId, label, check.openIssues)],
    };
  }
  if (sub === 'remove') {
    const removed = store.removeRepo(project.id, repo.owner, repo.name);
    if (removed) {
      boardHooks.changed(project.id);
      githubHooks.repoRemoved?.(project, repo.owner, repo.name);
    }
    return removed
      ? `Removed \`${label}\` from **${project.name}**.`
      : `\`${label}\` is not a repo of **${project.name}**.`;
  }
  const made = store.setDefaultRepo(project.id, repo.owner, repo.name);
  if (made) boardHooks.changed(project.id);
  return made
    ? `\`${label}\` is now the default repo of **${project.name}**.`
    : `\`${label}\` is not a repo of **${project.name}**; add it first.`;
}

function links(interaction: Interaction, ctx: FeatureContext, project: Project, sub: string): string {
  if (!canActOnProject(interaction.member, project, ctx.preset)) {
    return `Only members of **${project.name}** can change its links.`;
  }
  const store = projectsStore(ctx.db);
  const name = interaction.options.getString('name', true).trim();
  if (sub === 'remove') {
    const removed = store.removeLink(project.id, name);
    if (removed) boardHooks.changed(project.id);
    return removed ? `Removed the link **${name}**.` : `**${project.name}** has no link named **${name}**.`;
  }
  const url = interaction.options.getString('url', true).trim();
  if (!isValidLinkUrl(url)) return `\`${url}\` is not a web link; it must start with https:// or http://.`;
  const result = store.addLink(project.id, name, url);
  if (result === 'exists')
    return `**${project.name}** already has a link named **${name}**; remove it first.`;
  if (result === 'full') return `**${project.name}** already has ${MAX_LINKS} links, the most it can have.`;
  boardHooks.changed(project.id);
  return `Added the link **${name}** to **${project.name}**.`;
}

export function projectCommand(preset: Preset): FeatureCommand {
  return {
    data: command(preset),
    async execute(interaction, ctx) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand();
      let reply: Reply;
      if (sub === 'create' && !group) reply = await create(interaction, ctx);
      else if (sub === 'list' && !group) reply = list(ctx);
      else if (sub === 'sync' && interaction.options.getBoolean('all')) reply = await sync(undefined);
      else {
        const project = resolveProject(interaction, projectsStore(ctx.db));
        if (!project) reply = NO_PROJECT;
        else if (sub === 'refresh') reply = await refresh(interaction, ctx, project);
        else if (sub === 'sync') reply = await sync(project);
        else if (group === 'repo') reply = await repos(interaction, ctx, project, sub);
        else if (group === 'link') reply = links(interaction, ctx, project, sub);
        else reply = await membership(interaction, ctx, project, sub);
      }
      const message = typeof reply === 'string' ? { content: reply } : reply;
      await interaction.editReply({ ...message, allowedMentions: { parse: [] } });
    },
  };
}

async function refresh(interaction: Interaction, ctx: FeatureContext, project: Project): Promise<string> {
  const rebuild = interaction.options.getBoolean('board') ?? false;
  if (rebuild && !canManage(interaction, project, ctx)) {
    return 'Only the project creator or an admin can re-post the board.';
  }
  const r = await reconcileProject(ctx, project);
  const rebuilt = rebuild
    ? ` Re-posted the board in order (${await rebuildBoard(ctx, project.id)} old message(s) removed).`
    : '';
  const parts = [
    `adopted ${r.adopted} change(s) made in Discord`,
    `fixed ${r.fixed} post(s)`,
    `registered ${r.registered} new post(s)`,
    `marked ${r.deleted} ticket(s) with a deleted post as deleted`,
  ];
  const missing = r.missing.length ? `\n⚠️ Missing: ${r.missing.join(', ')}` : '';
  return `**${project.name}** checked: ${parts.join(', ')}. The board is being redrawn.${rebuilt}${missing}`;
}

/** /project sync: polls GitHub now for one project (or all of them) and reports what changed. */
async function sync(project: Project | undefined): Promise<string> {
  if (!githubHooks.sync) return 'GitHub is not connected (the github feature is off).';
  const r = await githubHooks.sync(project?.id);
  const what = project ? `**${project.name}**` : 'all projects';
  return `Synced ${what} with GitHub: ${r.changed} ticket(s) updated, ${r.created} new.`;
}
