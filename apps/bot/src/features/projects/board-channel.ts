import { EmbedBuilder } from 'discord.js';
import type { FeatureContext } from '../../feature.ts';
import { boardEmbeds, projectInfoEmbed } from './board.ts';
import { projectsStore } from './store.ts';
import { projectTemplate } from './tickets.ts';

/**
 * Redraws a project's #board: one bot message per status, edited in place. A missing message is
 * posted again (at the bottom). Messages of statuses that left the template are left alone; the
 * bot never deletes them.
 */
export async function redrawBoard(ctx: FeatureContext, projectId: number): Promise<void> {
  const store = projectsStore(ctx.db);
  const project = store.project(projectId);
  if (!project) return;
  const channel = ctx.guild.channels.cache.get(project.boardId);
  if (!channel?.isTextBased() || !channel.isSendable()) {
    return ctx.log.warn('projects', `#board of ${project.key} is missing`);
  }
  // The project info message comes first, then one message per status.
  const embeds = [
    { status: 'info', embed: projectInfoEmbed(project, store.repos(project.id), store.links(project.id)) },
    ...boardEmbeds(store.tickets(project.id), projectTemplate(ctx, project)),
  ];
  const ids = { ...project.boardMessageIds };
  const shown = new Set(embeds.map((e) => e.status));
  // The "unknown status" message, once there are no such tickets anymore, says so instead of going stale.
  if (ids['?'] && !shown.has('?')) {
    embeds.push({
      status: '?',
      embed: new EmbedBuilder().setTitle('Unknown status (0)').setDescription('nothing here'),
    });
  }
  for (const { status, embed } of embeds) {
    const id = ids[status];
    const existing = id ? await channel.messages.fetch(id).catch(() => null) : null;
    if (existing) {
      await existing.edit({ embeds: [embed], allowedMentions: { parse: [] } });
    } else {
      const message = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      ids[status] = message.id;
    }
  }
  store.setBoardMessageIds(project.id, ids);
}

/**
 * Puts the board back in template order: deletes the bot's own board messages (only those, checked
 * by author) and posts them again. Returns how many messages were deleted.
 */
export async function rebuildBoard(ctx: FeatureContext, projectId: number): Promise<number> {
  const store = projectsStore(ctx.db);
  const project = store.project(projectId);
  if (!project) return 0;
  const channel = ctx.guild.channels.cache.get(project.boardId);
  if (!channel?.isTextBased()) return 0;
  let deleted = 0;
  for (const id of Object.values(project.boardMessageIds)) {
    const message = await channel.messages.fetch(id).catch(() => null);
    if (message?.author.id === ctx.client.user.id) {
      await message.delete();
      deleted++;
    }
  }
  store.setBoardMessageIds(project.id, {});
  await redrawBoard(ctx, project.id);
  return deleted;
}
