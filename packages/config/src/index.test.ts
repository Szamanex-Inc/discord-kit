import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { channelName, ConfigError, killedFeatures, loadPreset, presetEnabled, REPO_ROOT } from './index.ts';

const EXAMPLE = join(REPO_ROOT, 'presets/example');

/** Writes a preset with the given config.yaml into a temp folder and returns its path. */
function tempPreset(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'discord-kit-'));
  mkdirSync(join(dir, 'content'));
  writeFileSync(join(dir, 'config.yaml'), yaml);
  return dir;
}

const MINIMAL = `schema_version: 2
roles: [{ name: Admin }]
categories: [{ name: INFO, channels: [{ name: rules }] }]
`;

function assertConfigError(yaml: string, pattern: RegExp) {
  assert.throws(
    () => loadPreset(tempPreset(yaml)),
    (e: unknown) => e instanceof ConfigError && pattern.test(e.message),
  );
}

test('loads the example preset', () => {
  const preset = loadPreset(EXAMPLE);
  assert.ok(preset.config.roles.length > 0);
  assert.deepEqual(preset.memberRoles, ['Admin', 'Moderator', 'Member']);
});

test('loads a minimal preset', () => {
  assert.equal(loadPreset(tempPreset(MINIMAL)).config.categories.length, 1);
});

test('requires schema_version', () => {
  assertConfigError(MINIMAL.replace('schema_version: 2\n', ''), /add "schema_version: 2"/);
});

test('rejects an unsupported schema_version', () => {
  assertConfigError(MINIMAL.replace('schema_version: 2', 'schema_version: 1'), /preset has 1.*migrations/s);
});

test('rejects unknown keys', () => {
  assertConfigError(MINIMAL.replace('{ name: Admin }', '{ name: Admin, hosit: true }'), /hosit/);
});

test('rejects unknown features', () => {
  assertConfigError(
    MINIMAL + 'features: { welcom: { enabled: true } }\n',
    /features\.welcom not supported by this discord-kit version \(supported: .*welcome.*\)[\s\S]*upgrade/,
  );
});

test('requires enabled on a feature', () => {
  assertConfigError(
    MINIMAL + 'features: { role_picker: { channel: c, menus: [{ placeholder: p, roles: [Admin] }] } }\n',
    /enabled/,
  );
});

test('checks roles in feature settings', () => {
  assertConfigError(
    MINIMAL +
      'features: { role_picker: { enabled: false, channel: c, menus: [{ placeholder: p, roles: [Ghost] }] } }\n',
    /unknown role 'Ghost'/,
  );
});

test('accepts a welcome feature', () => {
  const preset = loadPreset(
    tempPreset(MINIMAL + 'features: { welcome: { enabled: true, channel: rules, message: hi } }\n'),
  );
  assert.equal(preset.config.features?.welcome?.message, 'hi');
});

test('rejects an empty welcome feature', () => {
  assertConfigError(
    MINIMAL + 'features: { welcome: { enabled: true } }\n',
    /at least one of message, dm or auto_roles/,
  );
});

test('rejects a welcome message without a channel', () => {
  assertConfigError(
    MINIMAL + 'features: { welcome: { enabled: true, message: hi } }\n',
    /message needs a channel/,
  );
});

test('checks welcome auto_roles', () => {
  assertConfigError(
    MINIMAL + 'features: { welcome: { enabled: true, auto_roles: [Ghost] } }\n',
    /auto_roles: unknown role 'Ghost'/,
  );
});

test('accepts an applications feature', () => {
  const yaml =
    MINIMAL +
    'features: { applications: { enabled: true, channel: a, review_channel: b, questions: [{ label: Q }] } }\n';
  assert.equal(loadPreset(tempPreset(yaml)).config.features?.applications?.questions.length, 1);
});

test('limits applications to 5 questions', () => {
  const q = Array.from({ length: 6 }, (_, i) => `{ label: Q${i} }`).join(', ');
  assertConfigError(
    MINIMAL +
      `features: { applications: { enabled: true, channel: a, review_channel: b, questions: [${q}] } }\n`,
    /questions/,
  );
});

test('checks applications roles', () => {
  assertConfigError(
    MINIMAL +
      'features: { applications: { enabled: true, channel: a, review_channel: b, questions: [{ label: Q }], accept_roles: [Ghost] } }\n',
    /accept_roles: unknown role 'Ghost'/,
  );
});

test('checks bot.admin_roles', () => {
  assertConfigError(MINIMAL + 'bot: { admin_roles: [Ghost] }\n', /bot.admin_roles: unknown role 'Ghost'/);
});

test('rejects undefined roles', () => {
  assertConfigError(
    MINIMAL.replace('{ name: rules }', '{ name: rules, private: [Ghost] }'),
    /unknown role 'Ghost'/,
  );
});

test('rejects duplicate roles', () => {
  assertConfigError(
    MINIMAL.replace('[{ name: Admin }]', '[{ name: Admin }, { name: Admin }]'),
    /duplicate role/,
  );
});

test('rejects missing content files', () => {
  assertConfigError(
    MINIMAL.replace('{ name: rules }', '{ name: rules, content: content/nope.md }'),
    /not found/,
  );
});

test('normalizes text channel names but not voice channel names', () => {
  assert.equal(channelName({ name: 'My Channels' }), 'my-channels');
  assert.equal(channelName({ name: 'Dungeon 1', type: 'voice' }), 'Dungeon 1');
});

test('reads feature state from the preset', () => {
  assert.equal(presetEnabled(loadPreset(EXAMPLE), 'role_picker'), true);
  assert.equal(presetEnabled(loadPreset(tempPreset(MINIMAL)), 'role_picker'), false);
});

test('parses the DISABLED_FEATURES kill switch', () => {
  assert.deepEqual([...killedFeatures({})], []);
  assert.deepEqual([...killedFeatures({ DISABLED_FEATURES: ' role_picker , ' })], ['role_picker']);
  assert.throws(() => killedFeatures({ DISABLED_FEATURES: 'nope' }), /unknown feature/);
});

test('accepts a log_channel defined in the preset', () => {
  const preset = loadPreset(tempPreset(MINIMAL + 'bot: { log_channel: rules }\n'));
  assert.equal(preset.config.bot?.log_channel, 'rules');
});

test('rejects a log_channel not defined in the preset', () => {
  assertConfigError(
    MINIMAL + 'bot: { log_channel: nowhere }\n',
    /bot\.log_channel: channel 'nowhere' is not defined/,
  );
});

test('the example preset logs to bot-logs', () => {
  assert.equal(loadPreset(EXAMPLE).config.bot?.log_channel, 'bot-logs');
});

test('accepts a projects feature with defaults', () => {
  const preset = loadPreset(tempPreset(MINIMAL + 'features: { projects: { enabled: true } }\n'));
  assert.equal(preset.config.features?.projects?.enabled, true);
});

test('rejects unknown projects creator_roles', () => {
  assertConfigError(
    MINIMAL + 'features: { projects: { enabled: true, creator_roles: [Ghost] } }\n',
    /features\.projects\.creator_roles: unknown role 'Ghost'/,
  );
});

test('rejects a projects default_template that is not defined', () => {
  assertConfigError(
    MINIMAL + 'features: { projects: { enabled: true, default_template: nope } }\n',
    /template 'nope' is not defined/,
  );
});

test('reads github app credentials from the environment', async () => {
  const { githubCredentials } = await import('./index.ts');
  assert.equal(githubCredentials({}), undefined);
  assert.deepEqual(
    githubCredentials({ GITHUB_APP_ID: '123', GITHUB_PRIVATE_KEY: '-----BEGIN-----\\nabc\\n-----END-----' }),
    {
      appId: '123',
      privateKey: '-----BEGIN-----\nabc\n-----END-----',
    },
  );
  const dir = tempPreset(MINIMAL);
  writeFileSync(join(dir, 'key.pem'), 'PEM');
  assert.equal(
    githubCredentials({ GITHUB_APP_ID: '1', GITHUB_PRIVATE_KEY_FILE: join(dir, 'key.pem') })?.privateKey,
    'PEM',
  );
});

test('explains half-configured github credentials', async () => {
  const { githubCredentials } = await import('./index.ts');
  assert.throws(() => githubCredentials({ GITHUB_APP_ID: '1' }), /GITHUB_PRIVATE_KEY/);
  assert.throws(() => githubCredentials({ GITHUB_PRIVATE_KEY: 'x' }), /GITHUB_APP_ID/);
  assert.throws(
    () => githubCredentials({ GITHUB_APP_ID: '1', GITHUB_PRIVATE_KEY_FILE: '/nope/key.pem' }),
    /cannot read/,
  );
});
