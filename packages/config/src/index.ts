/**
 * Shared config for all apps: preset types, loading and validating config.yaml,
 * and environment variables.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import YAML from 'yaml';
import { z } from 'zod';
import {
  ConfigSchema,
  FEATURES,
  type ChannelSpec,
  type Config,
  type FeatureConfig,
  type FeatureName,
} from './schema.ts';

/** Repository root (where .env and presets/ live). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export * from './schema.ts';
/** A loaded and validated preset. */
export interface Preset {
  dir: string;
  config: Config;
  /** `member_role`, always as a list. */
  memberRoles: string[];
}

export class ConfigError extends Error {}

/** Loads .env from the repository root. */
export function loadEnv(): void {
  dotenv.config({ path: join(REPO_ROOT, '.env'), quiet: true });
}

export function requireEnv<const K extends string>(...names: K[]): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const name of names) {
    const value = process.env[name];
    if (!value) throw new ConfigError(`Set the ${name} environment variable (for example in .env).`);
    out[name] = value;
  }
  return out;
}

/** Preset folder from PRESET_DIR (relative to the repo or absolute). The code assumes no preset. */
export function presetDir(): string {
  const dir = process.env.PRESET_DIR;
  if (!dir) {
    throw new ConfigError(
      'Set PRESET_DIR in .env, e.g. PRESET_DIR=presets/example.\n' +
        'If you do not have .env yet: cp .env.example .env',
    );
  }
  return isAbsolute(dir) ? dir : join(REPO_ROOT, dir);
}

/** Loads config.yaml from the preset and checks that every referenced role and file exists. */
export function loadPreset(dir: string = presetDir()): Preset {
  const path = join(dir, 'config.yaml');
  if (!existsSync(path)) throw new ConfigError(`File ${path} not found. Check PRESET_DIR.`);
  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError(`${path} is not valid YAML: ${(e as Error).message}`);
  }
  // A feature name this code does not know usually means the preset is newer than the image.
  const rawFeatures = (raw as { features?: unknown } | null)?.features;
  if (rawFeatures && typeof rawFeatures === 'object') {
    const unknown = Object.keys(rawFeatures).filter((n) => !(FEATURES as string[]).includes(n));
    if (unknown.length) {
      throw new ConfigError(
        `Errors in ${path}:\n✖ features.${unknown.join(', features.')} not supported by this discord-kit version ` +
          `(supported: ${FEATURES.join(', ')}).\n  Check the spelling, or upgrade discord-kit / the image tag.`,
      );
    }
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`Errors in ${path}:\n` + z.prettifyError(parsed.error));
  const config: Config = parsed.data;
  const memberRoles =
    typeof config.member_role === 'string' ? [config.member_role] : (config.member_role ?? []);

  const roleNames = new Set(config.roles.map((r) => r.name));
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const r of config.roles) {
    if (seen.has(r.name)) problems.push(`roles: duplicate role '${r.name}'`);
    seen.add(r.name);
  }
  const checkRoles = (where: string, names: string[] = []) => {
    for (const name of names) {
      if (!roleNames.has(name)) problems.push(`${where}: unknown role '${name}'`);
    }
  };

  checkRoles('member_role', memberRoles);
  for (const cat of config.categories) {
    checkRoles(`category ${cat.name}`, cat.private);
    for (const ch of cat.channels ?? []) {
      checkRoles(`channel ${ch.name}`, ch.private);
      checkRoles(`channel ${ch.name}`, ch.writers);
      if (ch.content && !existsSync(join(dir, ch.content))) {
        problems.push(`channel ${ch.name}: file '${ch.content}' not found`);
      }
    }
  }
  checkRoles('bot.admin_roles', config.bot?.admin_roles);
  const logChannel = config.bot?.log_channel;
  if (logChannel) {
    const defined = config.categories.flatMap((c) => c.channels ?? []).map(channelName);
    if (!defined.includes(channelName({ name: logChannel }))) {
      problems.push(`bot.log_channel: channel '${logChannel}' is not defined in categories`);
    }
  }
  checkRoles('features.welcome.auto_roles', config.features?.welcome?.auto_roles);
  const apps = config.features?.applications;
  checkRoles('features.applications.reviewer_roles', apps?.reviewer_roles);
  checkRoles('features.applications.accept_roles', apps?.accept_roles);
  checkRoles('features.applications.remove_roles', apps?.remove_roles);
  checkRoles('features.events.ping_roles', config.features?.events?.ping_roles);
  checkRoles('features.events.organizer_roles', config.features?.events?.organizer_roles);
  checkRoles('features.projects.creator_roles', config.features?.projects?.creator_roles);
  for (const menu of config.features?.role_picker?.menus ?? []) {
    checkRoles(`menu '${menu.placeholder}'`, menu.roles);
  }
  if (problems.length) throw new ConfigError(`Errors in ${path}:\n  ` + problems.join('\n  '));

  return { dir, config, memberRoles };
}

/** Whether the preset enables a feature. Runtime overrides and the kill switch are applied by the bot. */
export function presetEnabled(preset: Preset, name: FeatureName): boolean {
  return preset.config.features?.[name]?.enabled ?? false;
}

/**
 * Features force-disabled by the DISABLED_FEATURES environment variable (comma separated),
 * e.g. DISABLED_FEATURES=role_picker. Meant as an emergency kill switch only.
 */
export function killedFeatures(env: NodeJS.ProcessEnv = process.env): Set<FeatureName> {
  const names = (env.DISABLED_FEATURES ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  const unknown = names.filter((n) => !(FEATURES as string[]).includes(n));
  if (unknown.length) {
    throw new ConfigError(
      `DISABLED_FEATURES: unknown feature(s) ${unknown.join(', ')} (known: ${FEATURES.join(', ')})`,
    );
  }
  return new Set(names as FeatureName[]);
}

/** Settings of a feature from the preset, or undefined when the preset does not configure it. */
export function featureConfig<N extends FeatureName>(preset: Preset, name: N): FeatureConfig<N> | undefined {
  return preset.config.features?.[name] as FeatureConfig<N> | undefined;
}

/** Contents of the channel's `content` file. */
export function readContent(preset: Preset, channel: ChannelSpec): string {
  if (!channel.content) throw new ConfigError(`Channel ${channel.name} has no content field.`);
  return readFileSync(join(preset.dir, channel.content), 'utf8');
}

/** Discord lowercases text channel names and replaces spaces with dashes. */
export function channelName(ch: ChannelSpec): string {
  return (ch.type ?? 'text') === 'voice' ? ch.name : ch.name.toLowerCase().replaceAll(' ', '-');
}

/** Folder for the bot's runtime data (SQLite database). DATA_DIR, or `data/` in the repo. */
export function dataDir(): string {
  const dir = process.env.DATA_DIR;
  if (!dir) return join(REPO_ROOT, 'data');
  return isAbsolute(dir) ? dir : join(REPO_ROOT, dir);
}

/**
 * GitHub App credentials from the environment: GITHUB_APP_ID and the private key, either in
 * GITHUB_PRIVATE_KEY (literal "\n" allowed, as many .env files need) or in the file named by
 * GITHUB_PRIVATE_KEY_FILE. Undefined when neither is set; a half setup is a ConfigError.
 */
export function githubCredentials(
  env: NodeJS.ProcessEnv = process.env,
): { appId: string; privateKey: string } | undefined {
  const appId = env.GITHUB_APP_ID?.trim();
  const inline = env.GITHUB_PRIVATE_KEY;
  const file = env.GITHUB_PRIVATE_KEY_FILE?.trim();
  if (!appId && !inline && !file) return undefined;
  if (!appId) throw new ConfigError('GITHUB_APP_ID is missing (the GitHub App private key is set).');
  if (!inline && !file) {
    throw new ConfigError('Set GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_FILE (GITHUB_APP_ID is set).');
  }
  if (inline) return { appId, privateKey: inline.replaceAll('\\n', '\n') };
  try {
    return { appId, privateKey: readFileSync(file!, 'utf8') };
  } catch (e) {
    throw new ConfigError(`GITHUB_PRIVATE_KEY_FILE: cannot read ${file} (${(e as Error).message})`);
  }
}
