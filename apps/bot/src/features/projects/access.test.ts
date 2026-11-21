import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PermissionFlagsBits, type GuildMember } from 'discord.js';
import type { Preset } from '@discord-kit/config';
import { canActOnProject, canCreateProjects, projectOverwrites } from './access.ts';

function member(opts: { admin?: boolean; roles?: { id: string; name: string }[] } = {}): GuildMember {
  const roles = new Map((opts.roles ?? []).map((r) => [r.id, r]));
  return {
    permissions: { has: (bit: bigint) => Boolean(opts.admin) && bit === PermissionFlagsBits.Administrator },
    roles: {
      cache: {
        has: (id: string) => roles.has(id),
        some: (fn: (r: { name: string }) => boolean) => [...roles.values()].some(fn),
      },
    },
  } as unknown as GuildMember;
}

const preset = (over: Record<string, unknown> = {}) =>
  ({
    config: {
      bot: { admin_roles: ['Admin'] },
      features: { projects: { enabled: true, creator_roles: ['Lead'] } },
      ...over,
    },
  }) as unknown as Preset;

test('project members, admins and admin roles can act on a project', () => {
  const project = { roleId: 'r-project' };
  assert.equal(canActOnProject(member(), project, preset()), false);
  assert.equal(
    canActOnProject(member({ roles: [{ id: 'r-project', name: 'Project: demo' }] }), project, preset()),
    true,
  );
  assert.equal(canActOnProject(member({ admin: true }), project, preset()), true);
  assert.equal(
    canActOnProject(member({ roles: [{ id: 'r-admin', name: 'Admin' }] }), project, preset()),
    true,
  );
});

test('creator roles and admins can create projects', () => {
  assert.equal(canCreateProjects(member(), preset(), ['Lead']), false);
  assert.equal(canCreateProjects(member({ roles: [{ id: 'r1', name: 'Lead' }] }), preset(), ['Lead']), true);
  assert.equal(canCreateProjects(member({ admin: true }), preset()), true);
});

const has = (
  list: { id: string; allow?: bigint[]; deny?: bigint[] }[],
  id: string,
  kind: 'allow' | 'deny',
  bit: bigint,
) => Boolean(list.find((o) => o.id === id)?.[kind]?.includes(bit));

test('private projects are visible to the project role and the bot only', () => {
  const o = projectOverwrites({
    everyoneId: 'e',
    botId: 'b',
    projectRoleId: 'p',
    memberRoleIds: ['m'],
    visibility: 'private',
  });
  assert.ok(has(o.category, 'e', 'deny', PermissionFlagsBits.ViewChannel));
  assert.ok(has(o.category, 'p', 'allow', PermissionFlagsBits.ViewChannel));
  assert.ok(has(o.category, 'b', 'allow', PermissionFlagsBits.ViewChannel));
  assert.equal(
    o.category.some((x) => x.id === 'm'),
    false,
  );
});

test('public projects are visible to member roles too', () => {
  const o = projectOverwrites({
    everyoneId: 'e',
    botId: 'b',
    projectRoleId: 'p',
    memberRoleIds: ['m'],
    visibility: 'public',
  });
  assert.ok(has(o.category, 'e', 'deny', PermissionFlagsBits.ViewChannel));
  assert.ok(has(o.category, 'm', 'allow', PermissionFlagsBits.ViewChannel));
});

test('board and activity are read-only for everyone but the bot', () => {
  const o = projectOverwrites({
    everyoneId: 'e',
    botId: 'b',
    projectRoleId: 'p',
    memberRoleIds: ['m'],
    visibility: 'public',
  });
  for (const id of ['e', 'p', 'm'])
    assert.ok(has(o.readOnly, id, 'deny', PermissionFlagsBits.SendMessages), id);
  assert.ok(has(o.readOnly, 'b', 'allow', PermissionFlagsBits.SendMessages));
  assert.ok(has(o.readOnly, 'p', 'allow', PermissionFlagsBits.ViewChannel));
});
