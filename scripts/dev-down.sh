#!/usr/bin/env bash
# Stops the services. Postgres keeps running so no state is lost.
set -euo pipefail
cd "$(dirname "$0")/.."

for name in web worker orchestrator api; do
  if [ -f ".run/$name.pid" ]; then
    pid="$(cat ".run/$name.pid")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" && echo "stopped $name"
    fi
    rm -f ".run/$name.pid"
  fi
done

# Safety net. Matching on the command line is not enough: the Next server
# renames its own process, so the ports are the reliable handle.
for pattern in "apps/api/dist/main.js" "apps/orchestrator/dist/main.js" "apps/worker/dist/main.js" "apps/sandbox-manager/dist/main.js"; do
  pkill -f "$pattern" 2>/dev/null && echo "swept $pattern" || true
done

for port in 3000 4000 4100; do
  pid="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null && echo "freed port $port"
  fi
done

echo "Postgres is still running. Stop it with: docker stop ai-engine-postgres"
