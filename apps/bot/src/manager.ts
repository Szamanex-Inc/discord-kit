import { GatewayIntentBits, MessageFlags, type Client, type Guild, type Interaction } from 'discord.js';
import { ConfigError, FEATURES, presetEnabled, type FeatureName, type Preset } from '@discord-kit/config';
import type { Feature, FeatureCommand, FeatureContext } from './feature.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { FeatureOverride, OverridesStore } from './overrides.ts';
import type { Logger } from './log.ts';

export type FlagSource = 'preset' | 'override' | 'kill switch';

export interface FeatureState {
  name: FeatureName;
  /** Value from the preset. */
  preset: boolean;
  /** Runtime override set with /feature, if any. */
  override?: FeatureOverride;
  /** Force-disabled by DISABLED_FEATURES. */
  killed: boolean;
  /** Effective value after applying override and kill switch. */
  enabled: boolean;
  /** Which layer decided `enabled`. */
  source: FlagSource;
  /** Whether the module is currently started. */
  running: boolean;
  /** Last start error, if the module is enabled but failed to start. */
  error?: string;
}

/** Precedence: kill switch > runtime override > preset. */
export function resolveFlag(
  preset: boolean,
  override: boolean | undefined,
  killed: boolean,
): { enabled: boolean; source: FlagSource } {
  if (killed) return { enabled: false, source: 'kill switch' };
  if (override !== undefined) return { enabled: override, source: 'override' };
  return { enabled: preset, source: 'preset' };
}

interface Running {
  ctx: FeatureContext;
  /** Removes the listeners the feature registered through `ctx.on`. */
  cleanups: (() => void)[];
}

/** Starts and stops feature modules at runtime and keeps the guild's slash commands in sync. */
export class FeatureManager {
  private readonly running = new Map<FeatureName, Running>();
  private readonly errors = new Map<FeatureName, string>();
  private readonly coreCommands: FeatureCommand[];

  constructor(
    private readonly client: Client<true>,
    private readonly guild: Guild,
    private preset: Preset,
    private readonly db: DatabaseSync,
    private readonly overrides: OverridesStore,
    private readonly log: Logger,
    private readonly registry: Record<FeatureName, Feature>,
    private readonly killed: Set<FeatureName>,
    /** Builds the commands that are always available, e.g. /feature. */
    coreCommands: (manager: FeatureManager) => FeatureCommand[],
  ) {
    this.coreCommands = coreCommands(this);
    client.on('interactionCreate', (interaction) => void this.dispatch(interaction));
  }

  states(): FeatureState[] {
    const overrides = this.overrides.overrides();
    return FEATURES.map((name) => {
      const override = overrides.get(name);
      const fromPreset = presetEnabled(this.preset, name);
      const killed = this.killed.has(name);
      const error = this.errors.get(name);
      return {
        name,
        preset: fromPreset,
        ...(override && { override }),
        killed,
        ...resolveFlag(fromPreset, override?.enabled, killed),
        running: this.running.has(name),
        ...(error && { error }),
      };
    });
  }

  state(name: FeatureName): FeatureState {
    return this.states().find((s) => s.name === name)!;
  }

  /** Starts enabled modules that are not running, stops disabled ones, then updates slash commands. */
  async sync(): Promise<void> {
    for (const s of this.states()) {
      if (s.enabled && !s.running) await this.start(s.name);
      else if (!s.enabled && s.running) await this.stop(s.name);
    }
    await this.registerCommands();
  }

  /** The preset currently in use. */
  currentPreset(): Preset {
    return this.preset;
  }

  /**
   * Switches to a new preset without a restart: stops every running module, swaps the preset and
   * starts the enabled ones again, so each module re-reads its settings.
   */
  async reload(next: Preset): Promise<void> {
    for (const name of [...this.running.keys()]) await this.stop(name);
    this.errors.clear();
    this.preset = next;
    await this.sync();
  }

  /** Sets (true/false) or clears (undefined) the runtime override of a feature and applies it. */
  async setOverride(name: FeatureName, enabled: boolean | undefined, by: string): Promise<FeatureState> {
    if (enabled === undefined) this.overrides.clearOverride(name);
    else this.overrides.setOverride(name, enabled, by);
    await this.sync();
    return this.state(name);
  }

  private async start(name: FeatureName): Promise<void> {
    const feature = this.registry[name];
    const missing = feature.intents.filter((i) => !this.client.options.intents.has(i));
    if (missing.length) {
      const names = missing.map((i) => GatewayIntentBits[i]).join(', ');
      this.errors.set(name, `needs the ${names} intent(s), restart the bot to enable it`);
      this.log.warn(name, `cannot start without a restart: missing intents ${names}`);
      return;
    }
    const entry: Running = { ctx: undefined as never, cleanups: [] };
    entry.ctx = {
      client: this.client,
      guild: this.guild,
      preset: this.preset,
      db: this.db,
      log: this.log,
      on: (event, listener) => {
        this.client.on(event, listener);
        entry.cleanups.push(() => this.client.off(event, listener));
      },
    };
    try {
      await feature.start(entry.ctx);
      this.running.set(name, entry);
      this.errors.delete(name);
      this.log.info(name, 'started');
    } catch (e) {
      this.removeListeners(entry);
      const message = e instanceof ConfigError ? e.message : String(e);
      this.errors.set(name, message);
      // One broken module does not stop the others.
      this.log.error(name, 'failed to start', e instanceof ConfigError ? e.message : e);
    }
  }

  private async stop(name: FeatureName): Promise<void> {
    const entry = this.running.get(name);
    if (!entry) return;
    this.removeListeners(entry);
    this.running.delete(name);
    try {
      await this.registry[name].stop?.(entry.ctx);
    } catch (e) {
      this.log.error(name, 'error while stopping', e);
    }
    this.log.info(name, 'stopped');
  }

  private removeListeners(entry: Running): void {
    for (const cleanup of entry.cleanups) cleanup();
    entry.cleanups = [];
  }

  private activeCommands(): { command: FeatureCommand; ctx?: FeatureContext }[] {
    const out: { command: FeatureCommand; ctx?: FeatureContext }[] = this.coreCommands.map((command) => ({
      command,
    }));
    for (const [name, entry] of this.running) {
      const commands = this.registry[name].commands ?? [];
      const list = typeof commands === 'function' ? commands(entry.ctx.preset) : commands;
      for (const command of list) out.push({ command, ctx: entry.ctx });
    }
    return out;
  }

  private async registerCommands(): Promise<void> {
    // Guild commands update immediately, unlike global ones.
    await this.guild.commands.set(this.activeCommands().map(({ command }) => command.data));
  }

  private async dispatch(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand() || !interaction.inCachedGuild()) return;
    const found = this.activeCommands().find(({ command }) => command.data.name === interaction.commandName);
    if (!found) return;
    const ctx = found.ctx ?? {
      client: this.client,
      guild: this.guild,
      preset: this.preset,
      db: this.db,
      log: this.log,
      on: () => {
        throw new Error('Core commands cannot register listeners');
      },
    };
    try {
      await found.command.execute(interaction, ctx);
    } catch (e) {
      this.log.error(`command /${interaction.commandName}`, 'failed', e);
      const reply = { content: 'Something went wrong.', flags: MessageFlags.Ephemeral } as const;
      if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
      else await interaction.reply(reply).catch(() => {});
    }
  }
}
