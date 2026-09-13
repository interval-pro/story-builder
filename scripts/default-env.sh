#!/usr/bin/env bash
# The env file an installation starts with, written in one place.
#
# Nothing in it is a secret and nothing in it is a choice a person has to make:
# it records where the checkout is, where its state lives, and which port its
# own Postgres listens on. The port is the one value that differs from what the
# services assume by default (5432), and it differs on purpose, so this
# installation's database never collides with another Postgres already running
# on the machine.
#
# The GitHub token is not here. It is set from the cockpit and kept in the
# database, where it can be changed without a restart.
#
# Usage: write_default_env <env file> <install root> <state root> [container name]
write_default_env() {
  local file="$1" install_root="$2" state_root="$3" container="${4:-ai-engine-postgres}"
  local port="${PG_PORT:-5433}"
  mkdir -p "$(dirname "$file")"
  {
    echo "INSTALL_ROOT=$install_root"
    echo "STATE_ROOT=$state_root"
    echo "DATABASE_URL=postgres://ai_engine:ai_engine@localhost:$port/ai_engine"
    echo "PG_CONTAINER=$container"
    echo "PG_PORT=$port"
    echo "AGENT_ENGINE=claude-code"
    echo "AI_PROVIDER=mock"
    echo "API_PORT=4000"
    echo "LOG_LEVEL=info"
  } > "$file"
}
