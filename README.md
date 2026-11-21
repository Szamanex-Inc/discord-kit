# discord-kit

A config-driven toolkit for Discord servers. Everything specific to a server (roles, channels, content) lives in a **preset**; the code is generic and works with any preset.

## Structure

```
apps/
  setup/            one-off script: plan, setup, publish
  bot/              long-running bot, modules enabled by flags
packages/
  config/           preset types, config.yaml loading and validation, .env
presets/
  example/          neutral example preset, a starting point for your own
    config.yaml
    content/        channel content in Markdown
```

## Requirements

- Node.js 22+
- pnpm (`corepack enable`)
- A Discord bot invited to the server with the **Administrator** permission (or at least Manage Roles, Manage Channels, Manage Server, Manage Messages)

## Installation

```bash
pnpm install
cp .env.example .env
```

Fill in `.env`:

- `DISCORD_TOKEN`: the bot token from the [Discord Developer Portal](https://discord.com/developers/applications), **Bot** tab.
- `GUILD_ID`: the server ID (User Settings → Advanced → Developer Mode, then right-click the server → **Copy Server ID**).
- `DATA_DIR`: optional, where the bot keeps its SQLite database. Defaults to `data/` in the repo.
- `PRESET_DIR`: the preset folder, relative to the repo or absolute, e.g. `presets/example` or a preset in another repository. Required, the code assumes no preset.

## Inviting the bot

In the Developer Portal: **OAuth2 → URL Generator**, select the `bot` scope and the `Administrator` permission, open the generated link and pick the server.

The bot's role must be **higher** in the role list than the roles the script manages, otherwise it cannot reorder them.

## Commands

| Command                           | What it does                                                                                                                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm server:plan`                | Preview what would be created. Offline, no token needed.                                                                                                                                                                           |
| `pnpm server:setup`               | Creates missing roles and channels, sets the join message channel. Exits when done.                                                                                                                                                |
| `pnpm server:publish`             | Posts or updates channel content from `content` files. Exits when done.                                                                                                                                                            |
| `pnpm server:diff`                | Compares the preset with the server: what `server:setup` would create, what exists only on the server, and what differs. Read-only. Project channels and roles the bot created are skipped when the bot database is in `DATA_DIR`. |
| `pnpm server:export [--out file]` | Writes the server's roles and channels as a `config.yaml`. Works without a preset; useful as a backup or to start a preset from an existing server. Read-only.                                                                     |
| `pnpm bot`                        | The bot with the enabled features. Keeps running, Ctrl+C stops.                                                                                                                                                                    |
| `pnpm bot:dev`                    | Same, restarts on code changes.                                                                                                                                                                                                    |
| `pnpm typecheck`                  | Type-checks all packages.                                                                                                                                                                                                          |
| `pnpm lint`                       | Lints the code (oxlint, type-aware).                                                                                                                                                                                               |
| `pnpm test`                       | Runs the tests.                                                                                                                                                                                                                    |
| `pnpm format`                     | Formats the code (Prettier).                                                                                                                                                                                                       |

First run: `server:setup`, then `server:publish`, then `bot`.

The script never deletes anything and never modifies existing channels. Things that already exist (same name) are skipped, so it is safe to run repeatedly. `server:publish` only edits, and if needed deletes, messages the bot sent earlier.

## Presets

A preset is a folder with `config.yaml` and content files. The code knows no role names, channel names or texts; everything is in the preset. `presets/example` is a neutral starting point with instructions on what to change where: [presets/example/README.md](presets/example/README.md). Real server presets live outside this repository (usually in their own private repository) and are selected with `PRESET_DIR`; see [docs/deployment.md](docs/deployment.md).

Every field is documented in the comments of `config.yaml`. On startup the preset is validated against a schema (`packages/config/src/schema.ts`): unknown keys, wrong types, undefined roles and missing content files are reported with their location. `schema_version` in `config.yaml` must match the version the code supports, so an old preset fails loudly instead of being misread.

### Channel content

A channel with `content: "content/rules.md"` gets its content from that file. Edit the file and run `pnpm server:publish`. The bot edits its existing messages instead of sending new ones, so the channel stays clean. Long text (over ~1900 characters) is split into several messages at paragraph boundaries. Regular Discord markdown works. Publishing never pings anyone, even if the text mentions roles. In channels where other people post too, the bot's message is pinned.

## Bot and feature flags

The bot (`apps/bot`) is made of modules in `apps/bot/src/features/`. A module's state comes from three layers, highest priority first:

| Layer            | Where                                                  | Use it for                                           |
| ---------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| Kill switch      | `DISABLED_FEATURES=role_picker,...` in the environment | emergencies, e.g. a module crashing on startup       |
| Runtime override | `/feature on                                           | off <name>`on Discord, stored in SQLite in`DATA_DIR` | quick tests and temporary changes, no restart |
| Preset           | `features.<name>.enabled` in `config.yaml`             | the permanent state, changed through a PR            |

```yaml
features:
  role_picker:
    enabled: true
    channel: pick-roles
    menus: [...]
```

Each `features.<name>` entry holds `enabled` and the module's own settings. Modules are started and stopped at runtime: `/feature on` and `/feature off` apply immediately, `/feature reset` removes the override and goes back to the preset value, and `/feature list` shows every module with the layer that decided its state. These commands need Administrator or one of the preset's `bot.admin_roles`.

The client requests only the Discord intents of the modules enabled at startup, so a disabled module that needs a privileged intent never blocks the login. Enabling such a module later with `/feature on` asks for a restart.

The preset is reloaded without a restart when `config.yaml` changes, on `SIGHUP` and on `/deploy reload`; `/deploy status` shows what is live. See [docs/deployment.md](docs/deployment.md).

Module errors and warnings are written to the console and, when the preset sets `bot.log_channel` (e.g. `bot-logs`), posted to that channel in batches every few seconds (at most 20 per batch, never pinging anyone).

Slash commands are registered on the server automatically when the bot starts and whenever a module is enabled or disabled. `pnpm server:plan` shows the preset values and the kill switch.

| Feature        | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `role_picker`  | Role picker menu in `features.role_picker.channel`. On start it posts the menu or updates it to the current config.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `welcome`      | Greets new members with a message in `channel`, an optional DM and `auto_roles`. Needs the privileged **Server Members** intent (Developer Portal → Bot → Privileged Gateway Intents).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `applications` | A button in `channel` opens a form; submissions land in `review_channel` with Accept/Reject buttons. Accepting gives `accept_roles` and removes `remove_roles`, and the applicant gets a DM. Applications are stored in SQLite.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `events`       | `/event create title date time [ping] [duration] [description]` creates a Discord event, announces it in `channel` and posts reminders `remind_before` minutes before the start. `/event list`, `/event cancel`. Times are read in `timezone`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `projects`     | `/project create name [key] [template] [visibility] [repos]` creates a role, a category, a `#tickets` forum with one tag per status, and read-only `#board` and `#activity`. Other subcommands: `list`, `join`, `leave`, `member add` / `remove`, `repo add` / `remove` / `default` (as `owner/name` or a GitHub URL), `link add` / `remove` (any kind of link: designs, boards, docs), `refresh`. Tickets: `/ticket new title [description]` (or just post in `#tickets`), `/ticket edit [ticket]` opens a form for the title and description. For posts made by hand, edits to the description show in the bot’s control message. Use `/ticket move`, `assign`, `unassign`, `list`, `mine`, and Take, Leave, Move, Blocked (with a reason) and Unblock buttons in each post. Every change is kept with its history and posted to `#activity`; done tickets are archived. `#board` starts with the project's template, repos and links, then lists the tickets per status, updated a few seconds after a change. Changing a post's status tag or name by hand is adopted (changes made while the bot was offline are picked up on start); `/project refresh` re-checks a project (`board:true` also re-posts the board in status order). `/profile edit` saves your GitHub username (to match GitHub assignees and pull request authors) and your email (private: only you can see it, with `/profile show`). Needs Community mode and the privileged **Message Content** intent. |
| `github`       | Connects to GitHub as a GitHub App (see [docs/github-app.md](docs/github-app.md)). Adding a repo to a project checks that the app is installed on it and that no other project has it, creates the status labels (`status: Todo`, …) and offers to import the open issues. Linked tickets and issues stay in sync both ways: status (labels, closed = done), title and assignees (only members who set their GitHub username with `/profile edit`: others get a one-time note in the ticket, and unmatched GitHub assignees show as `github: login (not linked)` in its control message); descriptions are set once and comments are not synced. GitHub is checked every `poll_minutes` (default 5) and with `/project sync`; `/ticket new` creates the issue in the default repo (or `repo:`), `/ticket link` and `/ticket push` connect existing tickets. Open pull requests are watched too: failing CI (once per commit), CI passing again, merge conflicts and requested changes are posted in the ticket the pull request refers to (`Fixes #12`), or in `#activity`, pinging only the author (when they set `/profile`). Needs `GITHUB_APP_ID` and the app's private key in the environment.                                                                                                                                                                                                                                                                                |

Without bot hosting, Discord's built-in Onboarding (Server Settings → Onboarding) can replace `role_picker`.

### Adding a module

1. Add its entry with settings to `FeaturesSchema` in `packages/config/src/schema.ts`.
2. Create `apps/bot/src/features/<name>.ts` that exports a `Feature` object (name, intents, optional slash commands, `start`, optional `stop`). Register listeners with `ctx.on`, so they are removed when the module is disabled.
3. Add it to the registry in `apps/bot/src/features/index.ts`. TypeScript rejects a feature without a module.
4. Configure it in the preset.

## Notes

Forum and announcement channels require Community mode on the server. Without it the script creates a regular text channel instead.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md): Conventional Commits, PRs to `main`, the PR description template.

## License

[MIT](LICENSE).
