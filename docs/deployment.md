# Deployment

The Docker image runs the toolkit with a preset mounted at runtime.

## Building the image

Build an image from this checkout:

```bash
docker build -t discord-kit:local .
```

If you publish your own image, pin the tag or digest in your deployment configuration. The image carries its version and commit when the build is given `VERSION` and `REVISION` build arguments.

## Running

The image expects:

- the preset mounted at `/preset` (`PRESET_DIR` defaults to `/preset`)
- `DISCORD_TOKEN` and `GUILD_ID` in the environment
- a writable volume at `/data` for the bot's SQLite database (`DATA_DIR` defaults to `/data`), so `/feature` overrides survive restarts

The default command starts the bot. One-off commands override it:

```bash
docker run --rm --env-file .env -v ./preset:/preset:ro -v ./data:/data discord-kit:local                # bot
docker run --rm --env-file .env -v ./preset:/preset:ro discord-kit:local pnpm server:setup       # roles and channels
docker run --rm --env-file .env -v ./preset:/preset:ro discord-kit:local pnpm server:publish     # channel content
```

A typical setup keeps the preset in its own repository with a `docker-compose.yml` that pins the image tag, mounts the preset and keeps `/data` in a volume.

## Reloading the preset

The bot reloads `config.yaml` without a restart when:

- the file changes (watched by default; set `PRESET_WATCH=false` to turn it off),
- it receives `SIGHUP`, e.g. `docker compose kill -s HUP bot`,
- an admin runs `/deploy reload`.

Every running module is restarted with the new settings. If the new file is invalid, the bot keeps the previous preset and logs the errors; `/deploy status` shows the result of the last reload. Changes of Discord intents (e.g. enabling `welcome` for the first time) still need a restart. Channel content is not reloaded by the bot; publish it with `pnpm server:publish`.

## What is live

`/deploy status` shows the discord-kit version and commit (from the image), the preset folder and commit, the last reload and every feature with the layer that decided its state.

The preset commit comes from, in order: `PRESET_REVISION`, a `.revision` file in the preset folder, or the folder's git commit. With a preset in its own git repository, a deploy script can write the file after `git pull`, so the value follows hot reloads:

```bash
git pull
git rev-parse --short HEAD > preset/.revision
```
