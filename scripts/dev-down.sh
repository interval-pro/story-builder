#!/usr/bin/env bash
# Stops the services. Postgres keeps running so no state is lost.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
. "$ROOT/scripts/state-root.sh"
STATE_ROOT="${STATE_ROOT:-$(state_root_for "${INSTALL_ROOT:-$ROOT}")}"
[ -f "$STATE_ROOT/env" ] && { set -a; . "$STATE_ROOT/env"; set +a; }
RUN_DIR="$STATE_ROOT/run"

for name in web worker orchestrator api; do
  if [ -f "$RUN_DIR/$name.pid" ]; then
    pid="$(cat "$RUN_DIR/$name.pid")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" && echo "stopped $name"
    fi
    rm -f "$RUN_DIR/$name.pid"
  fi
done

# Safety net for a service whose pid file was lost, which is how two workers
# came to run at once.
#
# pkill and pgrep are not usable here: on at least one macOS install they fail
# with "sysmond service not found" and return non-zero without matching
# anything, which made this whole sweep silently inert while reading as if it had
# run. Parsing ps is uglier and actually works everywhere.
sweep() {
  local pattern="$1"
  local pids
  # No match makes grep exit non-zero, which under set -e would end the script
  # before the ports are freed. Nothing to sweep is the normal case.
  pids="$(ps -Ao pid=,command= | grep -F "$pattern" | grep -v -F 'grep' | awk '{print $1}' || true)"
  for pid in $pids; do
    if kill "$pid" 2>/dev/null; then
      echo "swept $pattern ($pid)"
    fi
  done
}
for pattern in "apps/api/dist/main.js" "apps/orchestrator/dist/main.js" "apps/worker/dist/main.js" "apps/sandbox-manager/dist/main.js"; do
  sweep "$pattern"
done

for port in 3000 4000 4100; do
  pid="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null && echo "freed port $port"
  fi
done

# The workers are gone, so nothing is running any job they had claimed. Saying
# so now is what stops a project's directory staying locked until the lease
# times out, which reads from the cockpit as a system that is up and idle and
# refuses to start anything.
if [ -f apps/cli/dist/release-jobs.js ]; then
  node apps/cli/dist/release-jobs.js || true
fi

echo "Postgres is still running. Stop it with: docker stop \"${PG_CONTAINER:-ai-engine-postgres}\""
