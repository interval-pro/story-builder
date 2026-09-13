#!/usr/bin/env bash
# Starts the whole system on the host: Postgres in Docker, then the services.
#
# From a fresh clone this is the only command. It writes the default env file,
# starts Postgres, installs and builds if nothing is built, migrates, registers
# the installation and starts everything. Run again, it changes nothing that is
# already right.
#
# The worker runs as your user on purpose, because the Claude CLI reads its
# login from your home directory.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
. "$ROOT/scripts/preflight.sh"
. "$ROOT/scripts/state-root.sh"
. "$ROOT/scripts/default-env.sh"
guard_unexpected

# ---------------------------------------------------------------------------
# What this machine needs before anything else is worth trying.
# ---------------------------------------------------------------------------
[ -f "$ROOT/package.json" ] && [ -d "$ROOT/apps" ] && [ -d "$ROOT/packages" ] \
  || fail "$ROOT does not look like a Story Builder checkout." "Run this script from inside the repository you cloned."
need_node 20
need_docker
need_command curl "curl is used to check that the API came up. Install it with your package manager."
command -v lsof >/dev/null 2>&1 || warn "lsof is not installed, so ports cannot be checked before starting." \
  "If a port is already taken, the service that needs it will fail to start and its log will say so."

# ---------------------------------------------------------------------------
# The state directory and the env file.
# ---------------------------------------------------------------------------
export INSTALL_ROOT="${INSTALL_ROOT:-$ROOT}"
export STATE_ROOT="${STATE_ROOT:-$(state_root_for "$INSTALL_ROOT")}"
RUN_DIR="$STATE_ROOT/run"
ENV_FILE="${ENV_FILE:-$STATE_ROOT/env}"

if [ -e "$STATE_ROOT" ] && [ ! -d "$STATE_ROOT" ]; then
  fail "$STATE_ROOT exists and is a file, not a directory." \
    "It is where this installation keeps its state. Move that file out of the way and run this again."
fi
mkdir -p "$STATE_ROOT" "$RUN_DIR" "$STATE_ROOT/snapshots" "$STATE_ROOT/tmp" 2>/dev/null \
  || fail "Could not create $STATE_ROOT." "Check that your home directory is writable."

# An installation made before the state moved keeps its settings: the old file
# is taken over once, and the checkout is left with nothing machine-specific.
if [ -f "$ROOT/.env.local" ]; then
  if [ -f "$ENV_FILE" ]; then
    warn "$ROOT/.env.local is ignored." "Settings now live in $ENV_FILE. Delete .env.local once you have checked nothing in it is still needed."
  else
    step "Moving .env.local to $ENV_FILE"
    mv "$ROOT/.env.local" "$ENV_FILE"
  fi
fi

# A fresh clone has no env file, and there is nothing in one a person needs to
# decide. Writing the defaults is what makes starting from a clone one command.
if [ ! -f "$ENV_FILE" ]; then
  step "Writing $ENV_FILE"
  write_default_env "$ENV_FILE" "$INSTALL_ROOT" "$STATE_ROOT"
fi

check_env_file "$ENV_FILE"
set -a; . "$ENV_FILE"; set +a

# Two checkouts with the same directory name resolve to the same state
# directory. Letting the second one start would point it at the first one's
# database, build record and logs, and nothing would say so.
if [ -n "${INSTALL_ROOT:-}" ] && [ ! -d "$INSTALL_ROOT" ]; then
  # The checkout it was set up for is gone. Nearly always that is this same
  # checkout, moved or cloned again somewhere else, and its state is still the
  # right state. Taken over, and said so.
  warn "$STATE_ROOT was set up for $INSTALL_ROOT, which no longer exists." \
    "Taking it over for $ROOT. If that was a different installation, stop now and start this one with its own STATE_ROOT."
  sed -i.bak "s#^INSTALL_ROOT=.*#INSTALL_ROOT=$ROOT#" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  INSTALL_ROOT="$ROOT"
elif [ -n "${INSTALL_ROOT:-}" ] && [ "$(cd "$INSTALL_ROOT" 2>/dev/null && pwd -P)" != "$(pwd -P)" ]; then
  fail "$STATE_ROOT belongs to a different checkout." \
    "It was set up for $INSTALL_ROOT, and this is $ROOT. Either start that checkout instead, or give this one its own state:
  STATE_ROOT=\$HOME/.story-builder-other ./scripts/dev-up.sh"
fi

export INSTALL_ROOT="$ROOT"
export STATE_ROOT="${STATE_ROOT:-$(state_root_for "$INSTALL_ROOT")}"
export WORKSPACES_ROOT="${WORKSPACES_ROOT:-$STATE_ROOT/workspaces}"
PG_CONTAINER="${PG_CONTAINER:-ai-engine-postgres}"
PG_PORT="${PG_PORT:-5433}"
API_PORT="${API_PORT:-4000}"
WEB_PORT=3000
API_URL="${API_BASE_URL:-http://localhost:$API_PORT}"

case "$PG_PORT" in ''|*[!0-9]*) fail "PG_PORT in $ENV_FILE is not a port number." "Set it to a number such as 5433." "PG_PORT=$PG_PORT" ;; esac
case "$API_PORT" in ''|*[!0-9]*) fail "API_PORT in $ENV_FILE is not a port number." "Set it to a number such as 4000." "API_PORT=$API_PORT" ;; esac

# The services read DATABASE_URL and the container is published on PG_PORT. If
# they disagree the services quietly talk to some other Postgres on this
# machine, such as another project's on 5432, and the first sign is a migration
# failing against a database that is not ours.
if [ -z "${DATABASE_URL:-}" ]; then
  fail "DATABASE_URL is missing from $ENV_FILE." "Add this line, or delete the file to have the defaults written again:
  DATABASE_URL=postgres://ai_engine:ai_engine@localhost:$PG_PORT/ai_engine"
fi
url_port_value="$(url_port "$DATABASE_URL")"
if [ -n "$url_port_value" ] && [ "$url_port_value" != "$PG_PORT" ]; then
  fail "DATABASE_URL and PG_PORT in $ENV_FILE point at different ports." \
    "The container listens on $PG_PORT but the services would connect to $url_port_value, which is some other Postgres. Make them the same." \
    "DATABASE_URL=$DATABASE_URL" "PG_PORT=$PG_PORT"
fi

# An env file written by an older installer is missing keys the services now
# rely on. Only missing keys are added; anything already set is left alone.
ensure_env() {
  local key="$1" value="$2"
  if ! grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    step "Added $key to $ENV_FILE"
  fi
}
ensure_env INSTALL_ROOT "$INSTALL_ROOT"
ensure_env STATE_ROOT "$STATE_ROOT"
ensure_env PG_CONTAINER "$PG_CONTAINER"
ensure_env PG_PORT "$PG_PORT"

# ---------------------------------------------------------------------------
# Postgres.
# ---------------------------------------------------------------------------
step "Postgres"
container_state="$(docker inspect -f '{{.State.Status}}' "$PG_CONTAINER" 2>/dev/null || true)"

if [ -n "$container_state" ]; then
  image="$(docker inspect -f '{{.Config.Image}}' "$PG_CONTAINER" 2>/dev/null || true)"
  case "$image" in
    postgres*) ;;
    *) fail "A container called $PG_CONTAINER already exists and it is not a Postgres." \
         "It is running $image. Rename or remove it, or use a different name for this installation's database:
  set PG_CONTAINER=ai-engine-postgres-2 in $ENV_FILE" ;;
  esac

  # Read from the container's configuration rather than from `docker port`,
  # which answers nothing for a stopped container.
  published="$(docker inspect -f '{{range $k, $v := .HostConfig.PortBindings}}{{if eq $k "5432/tcp"}}{{(index $v 0).HostPort}}{{end}}{{end}}' "$PG_CONTAINER" 2>/dev/null || true)"
  if [ -n "$published" ] && [ "$published" != "$PG_PORT" ]; then
    fail "The $PG_CONTAINER container is published on port $published, but $ENV_FILE says $PG_PORT." \
      "Set PG_PORT=$published and the port in DATABASE_URL to $published, or remove the container to have it created again on $PG_PORT. Removing it deletes the database."
  fi

  if [ "$container_state" != "running" ]; then
    holder="$(port_holder "$PG_PORT")"
    [ -z "$holder" ] || fail "Port $PG_PORT is taken, so the $PG_CONTAINER container cannot start." \
      "Stop whatever holds it, or move this installation's database to a free port with PG_PORT and DATABASE_URL in $ENV_FILE." \
      "listening: $holder"
    if ! output="$(docker start "$PG_CONTAINER" 2>&1)"; then
      fail "The $PG_CONTAINER container exists but would not start." \
        "Look at what Docker said below. If the container is broken beyond repair, removing it deletes the database:
  docker rm -f $PG_CONTAINER" "$output"
    fi
  fi
else
  holder="$(port_holder "$PG_PORT")"
  [ -z "$holder" ] || fail "Port $PG_PORT is already taken by another program." \
    "This installation runs its own Postgres there. Stop that program, or pick a free port and set both PG_PORT and the port in DATABASE_URL in $ENV_FILE." \
    "listening: $holder"
  if ! output="$(docker run -d --name "$PG_CONTAINER" \
      -e POSTGRES_USER=ai_engine -e POSTGRES_PASSWORD=ai_engine -e POSTGRES_DB=ai_engine \
      -p "${PG_PORT}:5432" postgres:16-alpine 2>&1)"; then
    case "$output" in
      *"pull access denied"*|*"TLS handshake"*|*"dial tcp"*|*"no such host"*|*"Temporary failure"*)
        fail "Docker could not download the Postgres image." \
          "This needs the internet once, to fetch postgres:16-alpine. Check the connection and run this again." "$output" ;;
      *)
        fail "Docker could not create the Postgres container." "Look at what Docker said below." "$output" ;;
    esac
  fi
fi

if ! wait_until 60 docker exec "$PG_CONTAINER" pg_isready -U ai_engine -d ai_engine; then
  fail "Postgres did not become ready within a minute." \
    "Its own log is below. A container created by something else, with other credentials, looks exactly like this." \
    "$(docker logs --tail 15 "$PG_CONTAINER" 2>&1)"
fi

if ! output="$(docker exec "$PG_CONTAINER" psql -tA -U ai_engine -d ai_engine -c 'SELECT 1' 2>&1)"; then
  fail "Postgres is up, but the ai_engine user or database does not work in $PG_CONTAINER." \
    "The container was probably created by something else. Use another name with PG_CONTAINER in $ENV_FILE, or remove this one to have it created again, which deletes its data." \
    "$output"
fi

# ---------------------------------------------------------------------------
# The build.
# ---------------------------------------------------------------------------
# Nothing built, or dependencies gone from under a build: the services would die
# on their first import with a missing-module trace.
if [ ! -f apps/api/dist/main.js ] || [ ! -d node_modules ]; then
  step "Nothing built yet"
  "$ROOT/scripts/build.sh"
else
  built="$(sed -nE 's/.*"commit": *"([0-9a-f]+)".*/\1/p' "$STATE_ROOT/build.json" 2>/dev/null | head -1 || true)"
  head_commit="$(git rev-parse HEAD 2>/dev/null || true)"
  if [ -n "$built" ] && [ -n "$head_commit" ] && [ "$built" != "$head_commit" ]; then
    warn "Starting the build from ${built:0:10}, but the checkout is at ${head_commit:0:10}." \
      "The newer commits are not running. Rebuild from the System screen, or run ./scripts/build.sh and start again."
  fi
fi

step "Migrations"
if ! node packages/db/dist/cli/migrate.js > "$RUN_DIR/migrate.log" 2>&1; then
  fail "The database migrations failed." \
    "Nothing has been started. The migration log is below." "$(log_tail "$RUN_DIR/migrate.log")"
fi

# The installation is a project too, which is what lets a story change the
# system and what the System screen's rebuild reads. Asked of the database
# rather than a file, so a wiped database is registered again.
installed="$(docker exec "$PG_CONTAINER" psql -tA -U ai_engine -d ai_engine \
  -c "SELECT 1 FROM projects WHERE kind = 'INSTALLATION' LIMIT 1" 2>/dev/null || true)"
if [ "$installed" != "1" ]; then
  step "Registering the installation"
  node apps/cli/dist/main.js init --install-root "$INSTALL_ROOT" > "$RUN_DIR/init.log" 2>&1 \
    || fail "Registering the installation failed." "The log is below." "$(log_tail "$RUN_DIR/init.log")"
fi

# ---------------------------------------------------------------------------
# The services.
# ---------------------------------------------------------------------------
running() {
  [ -f "$RUN_DIR/$1.pid" ] && kill -0 "$(cat "$RUN_DIR/$1.pid")" 2>/dev/null
}

# A port held by something that is not this checkout's own service. Ours is
# fine, and starting again is a no-op; anything else is a clear stop now rather
# than a service that dies a second after it starts. "Ours" needs both the
# working directory and the command: a stray program started from inside the
# checkout is still somebody else's.
claim_port() {
  local port="$1" service="$2" pattern="$3" label="$4" holder pid
  running "$service" && return 0
  holder="$(port_holder "$port")"
  [ -z "$holder" ] && return 0
  pid="${holder%% *}"
  case "$holder" in
    *"$pattern"*)
      if owned_by_checkout "$pid" "$ROOT"; then
        fail "An earlier $label from this checkout is still running on port $port, but nothing recorded it." \
          "Stop everything cleanly and start again:
  ./scripts/dev-down.sh && ./scripts/dev-up.sh" "listening: $holder"
      fi
      fail "Port $port is taken by the $label of a different Story Builder checkout." \
        "Only one installation can use port $port at a time. Stop the other one with its own scripts/dev-down.sh, then run this again." \
        "listening: $holder"
      ;;
  esac
  fail "Port $port is taken by another program, and the $label needs it." \
    "Stop that program and run this again." "listening: $holder"
}

STARTED=""
start() {
  local name="$1"; shift
  if running "$name"; then
    step "$name already running"
    return
  fi
  step "$name"
  ( "$@" > "$RUN_DIR/$name.log" 2>&1 & echo $! > "$RUN_DIR/$name.pid" )
  STARTED="$STARTED $name"
}

label_of() {
  case "$1" in
    api) echo "API" ;;
    web) echo "cockpit" ;;
    *) echo "$1" ;;
  esac
}

# A start that fails part-way does not leave half a system behind. What this run
# started is stopped again, so the next attempt begins from the same place and
# nothing is left holding a port or a job.
abort_start() {
  local name pid
  for name in $STARTED; do
    pid="$(cat "$RUN_DIR/$name.pid" 2>/dev/null || true)"
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    rm -f "$RUN_DIR/$name.pid"
  done
  [ -n "$STARTED" ] && set -- "$1" "$2
Everything this attempt started has been stopped again." "${@:3}"
  fail "$@"
}

# A service that exits on its own within a few seconds of starting has told us
# why in its log. Saying so now beats waiting two minutes for a health check.
check_alive() {
  local name="$1"
  running "$name" || abort_start "The $(label_of "$name") stopped right after it started." "Its log is below." "$(log_tail "$RUN_DIR/$name.log")"
}

claim_port "$API_PORT" api "apps/api/dist/main.js" API
claim_port "$WEB_PORT" web "next" cockpit

start api node apps/api/dist/main.js
start orchestrator node apps/orchestrator/dist/main.js
start worker node apps/worker/dist/main.js

WEB_STAMP="$RUN_DIR/web-build.stamp"
# 1 is the only answer that means skip. A needless build costs a minute; a
# skipped one serves the cockpit from before the update. The lockfile and the
# env file count as sources: dependencies hoist to the root, and API_BASE_URL
# is inlined into the bundle at build time. Run through bash so a lost
# executable bit does not read as "always stale".
web_state=0
bash "$ROOT/scripts/web-build-stale.sh" "$ROOT/apps/web" "$WEB_STAMP" \
  "$ROOT/package-lock.json" "$ENV_FILE" >/dev/null || web_state=$?
if [ "$web_state" -ne 1 ]; then
  # Rebuilding under a live server would swap the bundle out from under it. Only
  # this checkout's own cockpit is stopped; a program on port 3000 that is not
  # ours was already refused above.
  if running web; then
    step "Stopping the cockpit to rebuild it"
    kill "$(cat "$RUN_DIR/web.pid")" 2>/dev/null || true
    wait_until 15 sh -c "! lsof -nP -iTCP:$WEB_PORT -sTCP:LISTEN -t" || true
  fi
  rm -f "$RUN_DIR/web.pid"
  # A finished build leaves a traced subset of Next under apps/web/node_modules,
  # which the next build then resolves Next from and fails on. It has to go
  # before every build.
  rm -rf apps/web/node_modules
  step "Building the cockpit"
  if ! ( cd apps/web && ulimit -n 8192 \
      && NEXT_PUBLIC_API_BASE_URL="$API_URL" npx next build ) > "$RUN_DIR/web-build.log" 2>&1; then
    abort_start "The cockpit build failed." "The build log is below." \
      "$(log_tail "$RUN_DIR/web-build.log" 25)"
  fi
  touch "$WEB_STAMP"
fi
# exec replaces the wrapper shell, so the recorded pid is the server itself.
start web sh -c "cd apps/web && NEXT_PUBLIC_API_BASE_URL='$API_URL' exec npx next start -p $WEB_PORT"

sleep 2
check_alive api
check_alive orchestrator
check_alive worker
check_alive web

# Bounded, because a rebuild runs this unattended and must not hang forever on a
# version that cannot start. The process is checked each second, so one that
# dies is reported at once rather than after the whole wait.
api_up() { curl -sf "$API_URL/api/health" >/dev/null 2>&1; }
waited=0
until api_up; do
  check_alive api
  [ "$waited" -ge 120 ] && abort_start "The API did not answer within two minutes." "It was running but not responding. Its log is below." "$(log_tail "$RUN_DIR/api.log")"
  sleep 1; waited=$((waited + 1))
done

waited=0
until curl -s -o /dev/null "http://localhost:$WEB_PORT" 2>/dev/null; do
  check_alive web
  [ "$waited" -ge 60 ] && abort_start "The cockpit did not answer within a minute." "Its log is below." "$(log_tail "$RUN_DIR/web.log")"
  sleep 1; waited=$((waited + 1))
done
check_alive worker
check_alive orchestrator

# ---------------------------------------------------------------------------
# Up. Say what works and what does not yet.
# ---------------------------------------------------------------------------
health="$(curl -s "$API_URL/api/health")"
echo
echo "Cockpit: http://localhost:$WEB_PORT"
case "$health" in
  *'"agentEngineReady":false'*)
    warn "The Claude Code CLI could not be run, so no agent can start." \
      "Install it and log in once with \`claude\` in a terminal. The cockpit works without it; stories will wait." ;;
esac
echo "Add the projects you want worked on from there."
