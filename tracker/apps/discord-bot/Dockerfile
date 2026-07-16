FROM node:22-alpine AS base
RUN npm install -g pnpm@10.33.2
WORKDIR /app

# Copy workspace manifests first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY apps/discord-bot/package.json ./apps/discord-bot/

# Install deps for the discord-bot workspace only. --no-frozen-lockfile so a
# slightly-stale local checkout on the deploy host doesn't fail the build;
# CI is the source of truth for lockfile integrity.
RUN pnpm install --no-frozen-lockfile --filter @alliance-tracker/discord-bot...

# Copy source
COPY packages/shared-types/src/ ./packages/shared-types/src/
COPY apps/discord-bot/src/ ./apps/discord-bot/src/
COPY tsconfig.base.json ./
COPY apps/discord-bot/tsconfig.json ./apps/discord-bot/

WORKDIR /app/apps/discord-bot

RUN mkdir -p /data/inbox

CMD ["node_modules/.bin/tsx", "src/index.ts"]
