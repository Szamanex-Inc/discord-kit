import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '@discord-kit/config';

export interface BuildInfo {
  /** discord-kit version: DISCORD_KIT_VERSION (set in the Docker image), or package.json. */
  version: string;
  /** discord-kit commit: DISCORD_KIT_REVISION (set in the Docker image), or the local git commit. */
  revision: string;
}

function git(dir: string): string | undefined {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

export function buildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version?: string };
  return {
    version: env.DISCORD_KIT_VERSION || pkg.version || 'dev',
    revision: env.DISCORD_KIT_REVISION || git(REPO_ROOT) || 'unknown',
  };
}

/**
 * Commit of the preset, read on every call so it follows hot reloads: PRESET_REVISION, a `.revision`
 * file in the preset folder (written by a deploy script after `git pull`), or the folder's git commit.
 */
export function presetRevision(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.PRESET_REVISION) return env.PRESET_REVISION;
  const file = join(dir, '.revision');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim() || 'unknown';
  return git(dir) || 'unknown';
}
