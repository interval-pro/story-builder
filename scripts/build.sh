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
. "$ROOT/scripts/preflight.sh"
. "$ROOT/scripts/state-root.sh"
guard_unexpected

SOURCE="LOCAL"
while [ $# -gt 0 ]; do
  case "$1" in
    --source)
      [ $# -ge 2 ] || fail "--source needs a value." "Use --source LOCAL or --source UPSTREAM."
      SOURCE="$2"; shift 2 ;;
    *) fail "Unknown option: $1" "Usage: ./scripts/build.sh [--source LOCAL|UPSTREAM]" ;;
  esac
done
case "$SOURCE" in LOCAL|UPSTREAM|INSTALL) ;; *) fail "--source must be LOCAL or UPSTREAM, not $SOURCE." "" ;; esac

need_node 20
need_command git "Install Git, then run this again. The build records which commit it was made from."
git -C "$ROOT" rev-parse HEAD >/dev/null 2>&1 \
  || fail "$ROOT is not a Git checkout with at least one commit." "Build from a clone of the repository, not from a copied directory."

export INSTALL_ROOT="${INSTALL_ROOT:-$ROOT}"
export STATE_ROOT="${STATE_ROOT:-$(state_root_for "$INSTALL_ROOT")}"
ENV_FILE="${ENV_FILE:-$STATE_ROOT/env}"
if [ -f "$ENV_FILE" ]; then
  check_env_file "$ENV_FILE"
  set -a; . "$ENV_FILE"; set +a
fi
RUN_DIR="$STATE_ROOT/run"
mkdir -p "$RUN_DIR" 2>/dev/null || fail "Could not create $RUN_DIR." "Check that your home directory is writable."

step "Dependencies"
if ! npm ci --no-audit --no-fund > "$RUN_DIR/build-dependencies.log" 2>&1; then
  log="$(log_tail "$RUN_DIR/build-dependencies.log" 20)"
  case "$log" in
    *ENOTFOUND*|*ETIMEDOUT*|*ECONNRESET*|*EAI_AGAIN*|*"network"*)
      fail "Installing dependencies failed: the npm registry could not be reached." \
        "Check the internet connection, or a proxy if you are behind one, and run this again." "$log" ;;
    *"package-lock.json"*|*EUSAGE*)
      fail "Installing dependencies failed: package.json and package-lock.json disagree." \
        "The lockfile in this checkout is out of date. Pull the latest main, or run npm install once to update it." "$log" ;;
    *ENOSPC*)
      fail "Installing dependencies failed: the disk is full." "Free some space and run this again." "$log" ;;
    *EACCES*|*EPERM*)
      fail "Installing dependencies failed: a file could not be written." \
        "Something in $ROOT/node_modules is owned by another user, often from an earlier sudo. Remove node_modules and run this again." "$log" ;;
    *)
      fail "Installing dependencies failed." "The log is below." "$log" ;;
  esac
fi

step "Workspaces"
if ! npm run build > "$RUN_DIR/build-workspaces.log" 2>&1; then
  errors="$(grep -E 'error TS' "$RUN_DIR/build-workspaces.log" | sort -u | head -10 || true)"
  if [ -n "$errors" ]; then
    fail "The TypeScript build failed." \
      "Services that are already running are not affected: they hold the code they started with. The compiler's errors are below." \
      "$errors" "(full log: $RUN_DIR/build-workspaces.log)"
  fi
  fail "The TypeScript build failed." "The log is below." "$(log_tail "$RUN_DIR/build-workspaces.log")"
fi

# The cockpit is built here rather than at start, so that a rebuild finds out
# about a broken page while the old version is still serving, which is the whole
# point of building before stopping anything.
step "Cockpit"
rm -rf apps/web/node_modules
if ! ( cd apps/web && ulimit -n 8192 \
    && NEXT_PUBLIC_API_BASE_URL="${API_BASE_URL:-http://localhost:${API_PORT:-4000}}" npx next build ) \
    > "$RUN_DIR/build-cockpit.log" 2>&1; then
  fail "The cockpit build failed." "The log is below." "$(log_tail "$RUN_DIR/build-cockpit.log" 25)"
fi
touch "$RUN_DIR/web-build.stamp"

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
step "Built $commit"
if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
  warn "The checkout has uncommitted changes." \
    "They are in this build, but build.json can only name the commit, so the System screen will keep saying there are changes that are not running."
fi
