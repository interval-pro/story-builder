#!/usr/bin/env bash
# Builds this checkout and records which commit was built.
#
# The checkout moves whenever anything commits to it, including the system's own
# stories, so "what is checked out" and "what is running" drift apart constantly.
# build.json is the second fact, written only by a build that finished. That is
# what lets the cockpit say there are changes here that are not running, and it
# is the one rollback target a failed rebuild has.
#
#   ./scripts/build.sh              # dependencies, workspaces, cockpit
#   ./scripts/build.sh --source UPSTREAM
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
. "$ROOT/scripts/state-root.sh"

SOURCE="LOCAL"
while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

export INSTALL_ROOT="${INSTALL_ROOT:-$ROOT}"
export STATE_ROOT="${STATE_ROOT:-$(state_root_for "$INSTALL_ROOT")}"
ENV_FILE="${ENV_FILE:-$STATE_ROOT/env}"
[ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; }
mkdir -p "$STATE_ROOT"

echo "-> Dependencies"
npm ci --silent

echo "-> Workspaces"
npm run build --silent

# The cockpit is built here rather than at start, so that a rebuild finds out
# about a broken page while the old version is still serving, which is the whole
# point of building before stopping anything.
echo "-> Cockpit"
rm -rf apps/web/node_modules
( cd apps/web && ulimit -n 8192 \
  && NEXT_PUBLIC_API_BASE_URL="${API_BASE_URL:-http://localhost:4000}" npx next build )
touch "$STATE_ROOT/run/web-build.stamp" 2>/dev/null || {
  mkdir -p "$STATE_ROOT/run" && touch "$STATE_ROOT/run/web-build.stamp"
}

commit="$(git -C "$ROOT" rev-parse HEAD)"
tag="$(git -C "$ROOT" describe --tags --abbrev=0 2>/dev/null || true)"
cat > "$STATE_ROOT/build.json" <<JSON
{
  "commit": "$commit",
  "tag": $( [ -n "$tag" ] && printf '"%s"' "$tag" || printf 'null' ),
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source": "$SOURCE"
}
JSON
echo "-> Built $commit"
