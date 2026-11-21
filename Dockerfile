# discord-kit runtime image. The preset is not part of the image: mount it at /preset.
FROM node:24-slim

# Shown by /deploy status. Set by the image workflow from the git tag and commit.
ARG VERSION=dev
ARG REVISION=unknown

ENV DISCORD_KIT_VERSION=$VERSION \
    DISCORD_KIT_REVISION=$REVISION \
    PRESET_DIR=/preset \
    DATA_DIR=/data \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable

# Fetch dependencies from the lockfile only, so this layer is cached until the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

COPY . .
# Dev dependencies are needed at runtime: the code runs through tsx without a build step.
RUN pnpm install --offline --frozen-lockfile
ENV NODE_ENV=production

# Runtime data (SQLite) lives in a volume owned by the unprivileged user that ships with the node image.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node

# Default: the long-running bot. One-off commands: `docker compose run --rm bot pnpm server:setup`.
CMD ["pnpm", "bot"]
