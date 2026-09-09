# Shared image for the API, orchestrator, worker and sandbox manager.
FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* tsconfig.base.json tsconfig.build.json ./
COPY packages ./packages
COPY apps ./apps

RUN npm install --workspaces --include-workspace-root --ignore-scripts \
  && npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

# Git and the Docker CLI are needed by the worktree and sandbox code paths.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl docker.io postgresql-client \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps

RUN git config --global --add safe.directory '*'

CMD ["node", "apps/api/dist/main.js"]
