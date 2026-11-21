/**
 * Long-running bot. Feature modules from apps/bot/src/features are started and stopped at
 * runtime; their state comes from the preset, /feature overrides (SQLite) and DISABLED_FEATURES.
 * The preset is reloaded without a restart on SIGHUP, on /deploy reload and when config.yaml changes.
 */

import { Client, Events, GatewayIntentBits, type SendableChannels } from 'discord.js';
import {
  channelName,
  ConfigError,
  dataDir,
  FEATURES,
  killedFeatures,
  loadEnv,
  loadPreset,
  presetEnabled,
  requireEnv,
} from '@discord-kit/config';
import { deployCommand, type DeployInfo, type ReloadResult } from './commands/deploy.ts';
import { describeState, featureCommand } from './commands/feature.ts';
import { features } from './features/index.ts';
import { openDatabase } from './db.ts';
import { buildInfo, presetRevision } from './info.ts';
import { BotLogger } from './log.ts';
import { FeatureManager, resolveFlag } from './manager.ts';
import { OverridesStore } from './overrides.ts';
import { watchPreset } from './reload.ts';

async function main(): Promise<void> {
  loadEnv();
  const preset = loadPreset();
  const killed = killedFeatures();
  const { DISCORD_TOKEN, GUILD_ID } = requireEnv('DISCORD_TOKEN', 'GUILD_ID');
  const db = openDatabase(dataDir());
  const overridesStore = new OverridesStore(db);
  // Resolved once the bot is connected; until then warnings and errors go to the console only.
  let logChannel: () => SendableChannels | undefined = () => undefined;
  const log = new BotLogger({ channel: () => logChannel() });
  console.log(`Preset: ${preset.dir}`);
  console.log(`Data: ${dataDir()}`);

  // Intents of the modules enabled at startup. Some intents are privileged and must be switched on in
  // the Developer Portal; requesting them for disabled modules would block the login. A module that
  // needs more intents than the client has asks for a restart when enabled with /feature.
  const overrides = overridesStore.overrides();
  const atStartup = FEATURES.filter(
    (n) => resolveFlag(presetEnabled(preset, n), overrides.get(n)?.enabled, killed.has(n)).enabled,
  );
  const intents = new Set([GatewayIntentBits.Guilds, ...atStartup.flatMap((n) => features[n].intents)]);
  const client = new Client({ intents: [...intents] });

  const onReady = async (ready: Client<true>): Promise<void> => {
    const guild = await ready.guilds.fetch(GUILD_ID!).catch(() => null);
    if (!guild) {
      console.error('The bot cannot see a server with this GUILD_ID. Has it been invited?');
      await shutdown(1);
      return;
    }
    await guild.channels.fetch();
    await guild.roles.fetch();

    let lastReload: ReloadResult | undefined;
    let reloading = Promise.resolve<ReloadResult | undefined>(undefined);
    const info: DeployInfo = {
      build: buildInfo(),
      startedAt: new Date(),
      presetDir: () => manager.currentPreset().dir,
      presetRevision: () => presetRevision(manager.currentPreset().dir),
      lastReload: () => lastReload,
      // Reloads run one after another, so a burst of triggers cannot interleave.
      reload: () =>
        (reloading = reloading.then(async () => {
          try {
            await manager.reload(loadPreset(preset.dir));
            lastReload = { at: new Date(), ok: true };
            log.info('preset', 'reloaded');
          } catch (e) {
            const error = e instanceof ConfigError ? e.message : String(e);
            lastReload = { at: new Date(), ok: false, error };
            log.error('preset', 'reload failed, keeping the previous preset', error);
          }
          return lastReload;
        })) as Promise<ReloadResult>,
    };
    const manager = new FeatureManager(
      ready,
      guild,
      preset,
      db,
      overridesStore,
      log,
      features,
      killed,
      (m) => [featureCommand(m), deployCommand(info, m)],
    );
    logChannel = () => {
      const name = manager.currentPreset().config.bot?.log_channel;
      if (!name) return undefined;
      const channel = guild.channels.cache.find((c) => c.name === channelName({ name }));
      return channel?.isSendable() ? channel : undefined;
    };
    await manager.sync();

    // Hot reload: SIGHUP (e.g. `docker compose kill -s HUP bot`) or a change of config.yaml.
    process.on('SIGHUP', () => void info.reload());
    if (process.env.PRESET_WATCH !== 'false') watchPreset(preset.dir, () => void info.reload());
    for (const s of manager.states()) console.log(`  ${describeState(s).replaceAll('**', '')}`);
    console.log(`Logged in as ${ready.user.tag}. Ctrl+C to stop.`);
  };
  client.once(Events.ClientReady, (ready) => {
    onReady(ready).catch(async (e: unknown) => {
      console.error('Startup failed:', e instanceof ConfigError ? e.message : e);
      await shutdown(1);
    });
  });

  const shutdown = async (code = 0) => {
    // Post the last buffered errors while the client can still send.
    await log.close();
    await client.destroy();
    db.close();
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await client.login(DISCORD_TOKEN);
}

main().catch((e: unknown) => {
  console.error(e instanceof ConfigError ? e.message : e);
  process.exit(1);
});
