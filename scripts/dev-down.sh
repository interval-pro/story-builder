#!/usr/bin/env bash
# Stops the services. Postgres keeps running so no state is lost.
#
# Only this checkout's own processes are stopped. An earlier version matched
# every `node apps/api/dist/main.js` on the machine and killed whatever listened
# on ports 3000 and 4000, which also stopped a second checkout, or somebody
# else's app that happened to use the same port.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
. "$ROOT/scripts/preflight.sh"
. "$ROOT/scripts/state-root.sh"
guard_unexpected

STATE_ROOT="${STATE_ROOT:-$(state_root_for "${INSTALL_ROOT:-$ROOT}")}"
ENV_FILE="$STATE_ROOT/env"
RUN_DIR="$STATE_ROOT/run"

if [ ! -d "$STATE_ROOT" ]; then
  echo "Nothing to stop: $STATE_ROOT does not exist, so this checkout has never been started."
  exit 0
fi
if [ -f "$ENV_FILE" ]; then
  check_env_file "$ENV_FILE"
  set -a; . "$ENV_FILE"; set +a
fi

stopped=0
stop_pid() {
  local pid="$1" label="$2"
  kill "$pid" 2>/dev/null || return 0
  # Given a moment to exit on its own, then made to.
  if ! wait_until 10 sh -c "! kill -0 $pid"; then
    kill -9 "$pid" 2>/dev/null || true
    warn "The $label did not stop within ten seconds and was killed." ""
  fi
  echo "stopped $label"
  stopped=$((stopped + 1))
}

for name in web worker orchestrator api; do
  pidfile="$RUN_DIR/$name.pid"
  [ -f "$pidfile" ] || continue
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  case "$pid" in
    ''|*[!0-9]*) warn "$pidfile does not hold a process id and was removed." "" ;;
    *) kill -0 "$pid" 2>/dev/null && stop_pid "$pid" "$name" ;;
  esac
  rm -f "$pidfile"
done

# Safety net for a service whose pid file was lost, which is how two workers
# once came to run at once. Matched on the command and then confirmed by the
# process's working directory, so only this checkout's services are touched.
# ps rather than pgrep: on at least one macOS install pgrep fails with "sysmond
# service not found" and matches nothing while reading as if it had run.
for pattern in "apps/api/dist/main.js" "apps/orchestrator/dist/main.js" "apps/worker/dist/main.js" "apps/sandbox-manager/dist/main.js" "next start"; do
  pids="$(ps -Ao pid=,command= | grep -F "$pattern" | grep -v -F grep | awk '{print $1}' || true)"
  for pid in $pids; do
    owned_by_checkout "$pid" "$ROOT" && stop_pid "$pid" "stray ${pattern%% *}"
  done
done

# Ports still held after that are reported, never killed: whatever holds them is
# not ours.
for port in 3000 "${API_PORT:-4000}"; do
  holder="$(port_holder "$port")"
  [ -z "$holder" ] || warn "Port $port is still in use, by something that is not this checkout." "listening: $holder"
done

[ "$stopped" -eq 0 ] && echo "Nothing was running."

# The workers are gone, so nothing is running any job they had claimed. Saying
# so now stops a project's directory staying locked until the lease times out.
if [ -f apps/cli/dist/release-jobs.js ]; then
  container="${PG_CONTAINER:-ai-engine-postgres}"
  if command -v docker >/dev/null 2>&1 && [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" = "true" ]; then
    node apps/cli/dist/release-jobs.js || true
  else
    warn "The database is not running, so jobs that were in progress could not be handed back." \
      "They are picked up again automatically once their lease runs out after the next start."
  fi
fi

container="${PG_CONTAINER:-ai-engine-postgres}"
if command -v docker >/dev/null 2>&1 && [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" = "true" ]; then
  echo "Postgres is still running, so nothing is lost. Stop it with: docker stop $container"
fi
