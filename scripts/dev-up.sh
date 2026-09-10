#!/usr/bin/env bash
# Starts the whole system on the host: Postgres in Docker, then the services.
# The worker runs as your user on purpose, because the Claude CLI reads its
# login from your home directory.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
ENV_FILE="${ENV_FILE:-.env.local}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE. Run ./install.sh --repo <path> or copy .env.example." >&2
  exit 1
fi

set -a; . "./$ENV_FILE"; set +a

# Worktrees and artifacts belong to the installation, not to the repository
# being worked on, so they default to here rather than to PROJECT_ROOT.
export INSTALL_ROOT="${INSTALL_ROOT:-$ROOT}"
export WORKSPACES_ROOT="${WORKSPACES_ROOT:-$INSTALL_ROOT/.ai-workspaces}"
export ARTIFACTS_ROOT="${ARTIFACTS_ROOT:-$INSTALL_ROOT/.artifacts}"
PG_CONTAINER="${PG_CONTAINER:-ai-engine-postgres}"
PG_PORT="${PG_PORT:-5433}"
mkdir -p "$WORKSPACES_ROOT" "$ARTIFACTS_ROOT" .run

if [ -z "${PROJECT_ROOT:-}" ]; then
  echo "PROJECT_ROOT is not set in $ENV_FILE. The installation does not know which repository to work on." >&2
  exit 1
fi

echo "-> Postgres"
if ! docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
  docker start "$PG_CONTAINER" >/dev/null 2>&1 || docker run -d --name "$PG_CONTAINER" \
    -e POSTGRES_USER=ai_engine -e POSTGRES_PASSWORD=ai_engine -e POSTGRES_DB=ai_engine \
    -p "${PG_PORT}:5432" postgres:16-alpine >/dev/null
fi
until docker exec "$PG_CONTAINER" pg_isready -U ai_engine -d ai_engine >/dev/null 2>&1; do sleep 1; done

echo "-> Migrations"
node packages/db/dist/cli/migrate.js

start() {
  local name="$1"; shift
  if [ -f ".run/$name.pid" ] && kill -0 "$(cat ".run/$name.pid")" 2>/dev/null; then
    echo "-> $name already running"
    return
  fi
  echo "-> $name"
  ( "$@" > "$ROOT/.run/$name.log" 2>&1 & echo $! > "$ROOT/.run/$name.pid" )
}

start api node apps/api/dist/main.js
start orchestrator node apps/orchestrator/dist/main.js
start worker node apps/worker/dist/main.js

# A failed build leaves the .next directory behind without a BUILD_ID, so the
# marker is what tells us whether there is something worth starting.
if [ ! -f apps/web/.next/BUILD_ID ]; then
  echo "-> Building the cockpit"
  ( cd apps/web && ulimit -n 8192 && NEXT_PUBLIC_API_BASE_URL="${API_BASE_URL:-http://localhost:4000}" npx next build >/dev/null )
fi
# exec replaces the wrapper shell, so the recorded pid is the server itself and
# stopping it actually stops the server rather than an empty parent.
start web sh -c "cd apps/web && NEXT_PUBLIC_API_BASE_URL='${API_BASE_URL:-http://localhost:4000}' exec npx next start -p 3000"

# Bounded, because an apply runs this unattended and must not hang forever on
# a version that cannot start.
for _ in $(seq 1 120); do
  curl -sf "${API_BASE_URL:-http://localhost:4000}/api/health" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -sf "${API_BASE_URL:-http://localhost:4000}/api/health" >/dev/null 2>&1; then
  echo "The API did not come up within two minutes. See .run/api.log." >&2
  exit 1
fi

echo
echo "Project:  $PROJECT_ROOT"
echo "Cockpit: http://localhost:3000"
curl -s "${API_BASE_URL:-http://localhost:4000}/api/health"
echo
