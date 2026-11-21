/**
 * Discord server setup from a preset (config.yaml + content files).
 *
 *   plan     only prints what would be created (offline, no token needed)
 *   setup    creates missing roles and channels, then exits
 *   publish  posts or updates channel content from `content` files
 *   diff     compares the preset with the server (missing, extra, different)
 *   export   writes the server's roles and channels as a config.yaml (stdout or --out file)
 *
 * Never deletes anything and never modifies existing channels. Things that already exist
 * (same name) are skipped, so it is safe to run repeatedly.
 */

import { ConfigError, dataDir, loadEnv, loadPreset, requireEnv } from '@discord-kit/config';
import type { Guild } from 'discord.js';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { diffServer, printDiff } from './diff.ts';
import { withGuild } from './discord.ts';
import { exportPreset } from './export.ts';
import { managedIds } from './managed.ts';
import { printPlan } from './plan.ts';
import { runPublish } from './publish.ts';
import { runSetup } from './setup.ts';
import { snapshot } from './snapshot.ts';

const USAGE = 'Usage: tsx src/index.ts [plan|setup|publish|diff|export [--out file]]';

/** The server without the project channels and roles the bot created (they are not in presets). */
function serverSnapshot(guild: Guild) {
  const managed = managedIds(dataDir());
  if (!managed) {
    console.error(
      'Note: no bot database with projects in DATA_DIR; project channels created by the bot may show up as extras.',
    );
  }
  return snapshot(guild, managed);
}

async function main(): Promise<void> {
  loadEnv();
  const cmd = process.argv[2] ?? 'plan';

  // export reads the server only, so it works without a preset (e.g. to start one).
  if (cmd === 'export') {
    const { DISCORD_TOKEN, GUILD_ID } = requireEnv('DISCORD_TOKEN', 'GUILD_ID');
    return withGuild(DISCORD_TOKEN, GUILD_ID, async (_client, guild) => {
      const yaml = exportPreset(serverSnapshot(guild), guild.name);
      const out = outPath();
      if (!out) return void process.stdout.write(yaml);
      writeFileSync(out, yaml);
      console.error(`Exported ${guild.name} to ${out}`);
    });
  }

  const preset = loadPreset();
  console.log(`Preset: ${preset.dir}\n`);
  if (cmd === 'plan') return printPlan(preset);

  const { DISCORD_TOKEN, GUILD_ID } = requireEnv('DISCORD_TOKEN', 'GUILD_ID');
  switch (cmd) {
    case 'setup':
      return withGuild(DISCORD_TOKEN, GUILD_ID, (_client, guild) => runSetup(guild, preset));
    case 'publish':
      return withGuild(DISCORD_TOKEN, GUILD_ID, (client, guild) => runPublish(client, guild, preset));
    case 'diff':
      return withGuild(DISCORD_TOKEN, GUILD_ID, async (_client, guild) => {
        console.log(`Server: ${guild.name}\n`);
        printDiff(diffServer(preset, serverSnapshot(guild)));
      });
    default:
      throw new ConfigError(USAGE);
  }
}

/** `--out <file>`, resolved against the directory the command was started from. */
function outPath(): string | undefined {
  const i = process.argv.indexOf('--out');
  const file = i > 0 ? process.argv[i + 1] : undefined;
  if (!file) return undefined;
  // pnpm runs package scripts in the package folder; INIT_CWD is where the user ran pnpm.
  return resolve(process.env.INIT_CWD ?? process.cwd(), file);
}

main().catch((e: unknown) => {
  console.error(e instanceof ConfigError ? e.message : e);
  process.exit(1);
});
