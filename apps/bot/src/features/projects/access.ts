import { PermissionFlagsBits, type GuildMember } from 'discord.js';
import type { Preset } from '@discord-kit/config';

const hasRoleNamed = (member: GuildMember, names: string[] = []) =>
  member.roles.cache.some((r) => names.includes(r.name));

/** Administrator, or one of the preset's `bot.admin_roles`. */
export function isAdmin(member: GuildMember, preset: Preset): boolean {
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    hasRoleNamed(member, preset.config.bot?.admin_roles)
  );
}

/** Admins and the `creator_roles` from `features.projects` can run /project create. */
export function canCreateProjects(member: GuildMember, preset: Preset, creatorRoles: string[] = []): boolean {
  return isAdmin(member, preset) || hasRoleNamed(member, creatorRoles);
}

/** Admins and members with the project's role can change its tickets. */
export function canActOnProject(member: GuildMember, project: { roleId: string }, preset: Preset): boolean {
  return isAdmin(member, preset) || member.roles.cache.has(project.roleId);
}

/** A permission overwrite; assignable to discord.js OverwriteData. */
export interface Overwrite {
  id: string;
  allow?: bigint[];
  deny?: bigint[];
}

const { ViewChannel, SendMessages, SendMessagesInThreads, CreatePublicThreads, CreatePrivateThreads } =
  PermissionFlagsBits;

/**
 * Permission overwrites of a project's category and of its read-only channels (#board, #activity).
 * Private: only the project role and the bot see it (admins see everything anyway). Public: member
 * roles too.
 */
export function projectOverwrites(o: {
  everyoneId: string;
  botId: string;
  projectRoleId: string;
  memberRoleIds: string[];
  visibility: 'private' | 'public';
}): { category: Overwrite[]; readOnly: Overwrite[] } {
  const viewers = [o.projectRoleId, ...(o.visibility === 'public' ? o.memberRoleIds : [])];
  const category: Overwrite[] = [
    { id: o.everyoneId, deny: [ViewChannel] },
    ...viewers.map((id) => ({ id, allow: [ViewChannel] })),
    { id: o.botId, allow: [ViewChannel, SendMessages] },
  ];
  const noPosting = [SendMessages, SendMessagesInThreads, CreatePublicThreads, CreatePrivateThreads];
  const readOnly: Overwrite[] = [
    { id: o.everyoneId, deny: [ViewChannel, ...noPosting] },
    ...viewers.map((id) => ({ id, allow: [ViewChannel], deny: noPosting })),
    { id: o.botId, allow: [ViewChannel, SendMessages] },
  ];
  return { category, readOnly };
}
