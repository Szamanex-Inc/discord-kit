import { ChannelType, type ForumChannel, type Guild, type GuildBasedChannel, type Role } from 'discord.js';
import type { StatusSpec } from '@discord-kit/config';
import { projectOverwrites } from './access.ts';

export interface ProjectChannels {
  roleId: string;
  categoryId: string;
  forumId: string;
  boardId: string;
  activityId: string;
}

/**
 * Creates a project's role, category, #tickets forum (one tag per status), read-only #board and
 * #activity. If any step fails, what was created so far is removed again (all of it was created by
 * the bot a moment ago) and the error is rethrown.
 */
export async function createProjectChannels(
  guild: Guild,
  botId: string,
  opts: {
    name: string;
    template: StatusSpec[];
    visibility: 'private' | 'public';
    roleName: string;
    memberRoleIds: string[];
  },
): Promise<ProjectChannels> {
  const created: (Role | GuildBasedChannel)[] = [];
  const reason = `discord-kit project ${opts.name}`;
  try {
    const role = await guild.roles.create({ name: opts.roleName, reason });
    created.push(role);
    const overwrites = projectOverwrites({
      everyoneId: guild.roles.everyone.id,
      botId,
      projectRoleId: role.id,
      memberRoleIds: opts.memberRoleIds,
      visibility: opts.visibility,
    });
    const category = await guild.channels.create({
      name: opts.name.toUpperCase(),
      type: ChannelType.GuildCategory,
      permissionOverwrites: overwrites.category,
      reason,
    });
    created.push(category);
    const forum = await guild.channels.create({
      name: 'tickets',
      type: ChannelType.GuildForum,
      parent: category.id,
      permissionOverwrites: overwrites.category,
      topic: 'One post per ticket. Status is the tag; use the buttons in each post.',
      availableTags: opts.template.map((s) => ({
        name: s.label,
        moderated: false,
        emoji: s.emoji ? { id: null, name: s.emoji } : null,
      })),
      reason,
    });
    created.push(forum);
    const readOnly = (name: string, topic: string) =>
      guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: overwrites.readOnly,
        topic,
        reason,
      });
    const board = await readOnly('board', 'Tickets by status, kept up to date by the bot.');
    created.push(board);
    const activity = await readOnly('activity', 'Every ticket change, posted by the bot.');
    created.push(activity);
    return {
      roleId: role.id,
      categoryId: category.id,
      forumId: forum.id,
      boardId: board.id,
      activityId: activity.id,
    };
  } catch (e) {
    for (const item of created.reverse()) await item.delete(`${reason}: creation failed`).catch(() => {});
    throw e;
  }
}

/** The forum tag of a status, matched by label (case-insensitive) as tags are created from labels. */
export function tagIdFor(forum: ForumChannel, status: StatusSpec | undefined): string | undefined {
  if (!status) return undefined;
  return forum.availableTags.find((t) => t.name.toLowerCase() === status.label.toLowerCase())?.id;
}
