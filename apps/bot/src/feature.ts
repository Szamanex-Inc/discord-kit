import type {
  ChatInputCommandInteraction,
  Client,
  ClientEvents,
  GatewayIntentBits,
  Guild,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { FeatureName, Preset } from '@discord-kit/config';
import type { Logger } from './log.ts';
import type { DatabaseSync } from 'node:sqlite';

export interface FeatureContext {
  client: Client<true>;
  guild: Guild;
  preset: Preset;
  /** The bot's database. Modules open their own data class on it, e.g. eventsStore(ctx.db). */
  db: DatabaseSync;
  /** Console logging; warnings and errors also go to the preset's bot.log_channel. */
  log: Logger;
  /**
   * Registers a client event listener owned by the feature. The manager removes it when the
   * feature is disabled, so features never call `client.on` directly.
   */
  on: <E extends keyof ClientEvents>(event: E, listener: (...args: ClientEvents[E]) => unknown) => void;
}

/** A slash command owned by a feature. It is registered only while the feature is enabled. */
export interface FeatureCommand {
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  execute(interaction: ChatInputCommandInteraction<'cached'>, ctx: FeatureContext): Promise<void>;
}

/**
 * A bot module enabled by `features.<name>.enabled` in the preset, a /feature override or
 * DISABLED_FEATURES. Modules can be started and stopped at runtime without a restart.
 */
export interface Feature {
  name: FeatureName;
  /** Discord intents the module needs. The client is created with the intents of all modules. */
  intents: GatewayIntentBits[];
  /** Slash commands of the module, or a function building them from the current preset. */
  commands?: FeatureCommand[] | ((preset: Preset) => FeatureCommand[]);
  /** Registers listeners (through `ctx.on`) and does one-off work after connecting. */
  start(ctx: FeatureContext): Promise<void>;
  /** Extra cleanup on disable. Listeners registered through `ctx.on` are removed automatically. */
  stop?(ctx: FeatureContext): Promise<void>;
}
