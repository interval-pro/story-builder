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

echo "Postgres is still running. Stop it with: docker stop ai-engine-postgres"
