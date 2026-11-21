import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';
import { ConfigSchema, loadPreset } from '@discord-kit/config';
import { diffServer } from './diff.ts';
import { exportPreset } from './export.ts';
import { toSnakeCase, type ServerSnapshot } from './snapshot.ts';

function preset(yaml: string) {
  const dir = mkdtempSync(join(tmpdir(), 'discord-kit-diff-'));
  writeFileSync(join(dir, 'config.yaml'), yaml);
  return loadPreset(dir);
}

const PRESET = `schema_version: 2
roles:
  - { name: Admin, hoist: true, perms: [administrator] }
  - { name: Member, color: '#2ECC71' }
categories:
  - name: INFO
    channels: [{ name: Rules }, { name: Lounge, type: voice }]
`;

const SERVER: ServerSnapshot = {
  roles: [
    { name: 'Admin', hoist: true, mentionable: false, perms: ['administrator'] },
    { name: 'Member', color: '#FF0000', hoist: false, mentionable: false, perms: [] },
    { name: 'Old', hoist: false, mentionable: false, perms: [] },
  ],
  categories: [
    {
      name: 'INFO',
      channels: [
        { name: 'rules', type: 'text' },
        { name: 'memes', type: 'text' },
      ],
    },
    { name: 'ARCHIVE', channels: [] },
  ],
  uncategorized: [{ name: 'loose', type: 'text' }],
};

test('reports missing, extra and different things', () => {
  const diff = diffServer(preset(PRESET), SERVER);
  assert.deepEqual(diff.missing, ['channel INFO / 🔊 Lounge']);
  assert.deepEqual(diff.extra, [
    'role @Old',
    'channel INFO / memes',
    'category ARCHIVE (with 0 channels)',
    'channel loose (no category)',
  ]);
  assert.deepEqual(diff.changed, ['role @Member: color #FF0000 → #2ECC71']);
});

test('a server created from the preset has no differences', () => {
  const server: ServerSnapshot = {
    roles: [
      { name: 'Admin', hoist: true, mentionable: false, perms: ['administrator'] },
      { name: 'Member', color: '#2ECC71', hoist: false, mentionable: false, perms: [] },
    ],
    categories: [
      {
        name: 'INFO',
        channels: [
          { name: 'rules', type: 'text' },
          { name: 'Lounge', type: 'voice' },
        ],
      },
    ],
    uncategorized: [],
  };
  assert.deepEqual(diffServer(preset(PRESET), server), { missing: [], extra: [], changed: [] });
});

test('exports a valid preset', () => {
  const yaml = exportPreset(SERVER, 'Test');
  const parsed = ConfigSchema.safeParse(YAML.parse(yaml));
  assert.ok(parsed.success, parsed.success ? '' : String(parsed.error));
  assert.deepEqual(
    parsed.data!.categories.map((c) => c.name),
    ['INFO', 'ARCHIVE', 'NO CATEGORY'],
  );
  assert.match(yaml, /^# Exported from "Test"/);
});

test('converts permission flags to snake_case', () => {
  assert.equal(toSnakeCase('ManageMessages'), 'manage_messages');
  assert.equal(toSnakeCase('Administrator'), 'administrator');
});

test('every exported permission name is accepted by setup', async () => {
  const { PermissionFlagsBits } = await import('discord.js');
  const { permFlag } = await import('./discord.ts');
  for (const [key, bit] of Object.entries(PermissionFlagsBits))
    assert.equal(permFlag(toSnakeCase(key)), bit, key);
});
