import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { statusText } from './commands/deploy.ts';
import { buildInfo, presetRevision } from './info.ts';

test('build info prefers the image environment', () => {
  assert.deepEqual(buildInfo({ DISCORD_KIT_VERSION: '1.2.3', DISCORD_KIT_REVISION: 'abc1234' }), {
    version: '1.2.3',
    revision: 'abc1234',
  });
});

test('preset revision reads the .revision file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-kit-rev-'));
  writeFileSync(join(dir, '.revision'), 'aaa1111\n');
  assert.equal(presetRevision(dir, {}), 'aaa1111');
});

test('preset revision prefers PRESET_REVISION', () => {
  assert.equal(presetRevision('/nonexistent', { PRESET_REVISION: 'def5678' }), 'def5678');
  assert.equal(presetRevision('/nonexistent', {}), 'unknown');
});

test('status shows version, preset, last reload and features', () => {
  const text = statusText(
    {
      build: { version: '1.2.3', revision: 'abc1234' },
      startedAt: new Date(0),
      presetDir: () => '/preset',
      presetRevision: () => 'def5678',
      lastReload: () => ({ at: new Date(0), ok: false, error: 'bad yaml' }),
      reload: async () => ({ at: new Date(0), ok: true }),
    },
    {
      states: () => [
        { name: 'welcome', preset: true, killed: false, enabled: true, source: 'preset', running: true },
      ],
    },
  );
  assert.match(text, /1\.2\.3 \(abc1234\)/);
  assert.match(text, /\/preset @ def5678/);
  assert.match(text, /failed, previous preset kept: bad yaml/);
  assert.match(text, /\*\*welcome\*\*: on \(preset\)/);
});
