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
# being worked on. They sit beside it rather than inside it, because installing
# a new version replaces the installation directory while the database that
# indexes them survives.
export INSTALL_ROOT="${INSTALL_ROOT:-$ROOT}"
export STATE_ROOT="${STATE_ROOT:-$INSTALL_ROOT.state}"
export WORKSPACES_ROOT="${WORKSPACES_ROOT:-$STATE_ROOT/workspaces}"
export ARTIFACTS_ROOT="${ARTIFACTS_ROOT:-$STATE_ROOT/artifacts}"
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

WEB_STAMP="$ROOT/.run/web-build.stamp"
# 1 is the only answer that means skip. A needless build costs a minute; a
# skipped one serves the cockpit from before the update. The lockfile and the
# env file count as sources: dependencies hoist to the root, and API_BASE_URL
# is inlined into the bundle at build time.
# Run through bash rather than as a command: a checkout that loses the
# executable bit would otherwise fail with exit 126 on every start, and since
# anything but 1 means rebuild, that reads as "always stale" and quietly
# rebuilds the cockpit every time.
web_state=0
bash "$ROOT/scripts/web-build-stale.sh" "$ROOT/apps/web" "$WEB_STAMP" \
  "$ROOT/package-lock.json" "$ROOT/$ENV_FILE" >/dev/null || web_state=$?
if [ "$web_state" -ne 1 ]; then
  # Rebuilding under a live server would swap the bundle out from under it.
  # Recorded pid first, then the port, because the Next server renames its own
  # process and dev-down.sh already learned not to trust the pid alone.
  web_pid=""
  if [ -f .run/web.pid ] && kill -0 "$(cat .run/web.pid)" 2>/dev/null; then
    web_pid="$(cat .run/web.pid)"
  fi
  port_pid="$(lsof -nP -iTCP:3000 -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [ -n "$web_pid" ] || [ -n "$port_pid" ]; then
    echo "-> Stopping the cockpit to rebuild it"
    [ -n "$web_pid" ] && kill "$web_pid" 2>/dev/null || true
    [ -n "$port_pid" ] && kill "$port_pid" 2>/dev/null || true
  fi
  rm -f .run/web.pid
  echo "-> Building the cockpit"
  if ! ( cd apps/web && ulimit -n 8192 \
      && NEXT_PUBLIC_API_BASE_URL="${API_BASE_URL:-http://localhost:4000}" npx next build ) \
      > "$ROOT/.run/web-build.log" 2>&1; then
    echo "The cockpit build failed. See .run/web-build.log." >&2
    exit 1
  fi
  # Only now. The stamp records a build that finished, so a failure leaves the
  # next start to try again.
  touch "$WEB_STAMP"
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
