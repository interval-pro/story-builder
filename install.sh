#!/usr/bin/env bash
# Installs Story Builder.
#
# The engine is cloned from its latest release into its own directory, outside
# any repository it works on, and started. Projects are added afterwards from
# the cockpit, one click each, and nothing whatsoever is written into them.
#
#   ./install.sh
#   ./install.sh --repo /absolute/path/to/a/repository   # adds one immediately
#
# Options:
#   --repo <path>    optionally add this repository as the first project
#   --dir <path>     where to install, default ~/story-builder
#   --source <url>   where to install from, a URL or a local checkout
#   --ref <tag>      install this tag or branch instead of the latest release
#   --name <name>    name of the installation's database container suffix
#
# If you cloned the repository yourself, you do not need this script:
# ./scripts/dev-up.sh from inside the clone does everything below.
set -euo pipefail

# This runs before there is a checkout, so it cannot use scripts/preflight.sh
# yet. The same shape, kept small: what happened, then what to do.
fail() {
  echo >&2
  echo "✗ $1" >&2
  [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/  /' >&2
  echo >&2
  exit 1
}
need() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is not installed, or it is not on your PATH." "$2"
}

SOURCE_URL="${SOURCE_URL:-https://github.com/interval-pro/story-builder.git}"
REPO=""
NAME=""
INSTALL_DIR=""
REF=""

while [ $# -gt 0 ]; do
  case "$1" in
    --repo|--name|--dir|--ref|--source)
      [ $# -ge 2 ] && [ -n "$2" ] || fail "$1 needs a value." "Run ./install.sh --help to see the options."
      case "$1" in
        --repo) REPO="$2" ;;
        --name) NAME="$2" ;;
        --dir) INSTALL_DIR="$2" ;;
        --ref) REF="$2" ;;
        --source) SOURCE_URL="$2" ;;
      esac
      shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) fail "Unknown option: $1" "Run ./install.sh --help to see the options." ;;
  esac
done

need git "Install Git, then run this again."
need curl "Install curl, then run this again."
need node "Install Node.js 20 or newer from https://nodejs.org, then run this again."
need docker "Install Docker Desktop from https://www.docker.com/products/docker-desktop, start it, then run this again."
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 \
  || fail "Docker is installed but not running." "Start Docker Desktop, wait until it says it is running, then run this again."

if [ -n "$REPO" ]; then
  [ -d "$REPO" ] || fail "$REPO does not exist." "Pass the path of a Git repository with at least one commit."
  REPO="$(cd "$REPO" && pwd)"
  git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || fail "$REPO is not a Git repository." "Pass the path of a Git repository, or leave --repo out and add projects from the cockpit."
  git -C "$REPO" rev-parse HEAD >/dev/null 2>&1 \
    || fail "$REPO has no commits yet." "Every story starts from a commit. Make the first one, then run this again."
  REPO="$(git -C "$REPO" rev-parse --show-toplevel)"
fi
NAME="${NAME:-story-builder}"
# One level, and no directory named twice. The checkout holds code; everything
# machine-specific lives in the state directory in your home, not in here.
INSTALL_DIR="${INSTALL_DIR:-$HOME/story-builder}"

if [ -e "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR" ]; then
  fail "$INSTALL_DIR exists and is a file." "Pass --dir to install somewhere else."
fi
if [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
  if [ -d "$INSTALL_DIR/.git" ] && [ -f "$INSTALL_DIR/scripts/dev-up.sh" ]; then
    fail "Story Builder is already installed in $INSTALL_DIR." "Start it with:
  cd $INSTALL_DIR && ./scripts/dev-up.sh
To install a second copy, pass --dir with another path."
  fi
  fail "$INSTALL_DIR already exists and is not empty." "Pass --dir to install somewhere else, or empty that directory first."
fi

# The release is the unit of installation. A local source is allowed so an
# installation can be made from a checkout you already have, with or without a
# network, and the newest tag stands in for the release in that case.
if [ -z "$REF" ]; then
  if [ -d "$SOURCE_URL" ]; then
    echo "-> Reading the newest tag in $SOURCE_URL"
    REF="$(git -C "$SOURCE_URL" tag --list --sort=-v:refname 2>/dev/null | head -1)"
    [ -n "$REF" ] || fail "$SOURCE_URL has no tags." "Pass --ref <tag or branch> to choose a version."
  else
    echo "-> Looking up the latest release"
    slug="$(printf '%s' "$SOURCE_URL" | sed -E 's#^.*github\.com[:/]##; s#\.git$##')"
    if ! response="$(curl -fsSL "https://api.github.com/repos/$slug/releases/latest" 2>&1)"; then
      case "$response" in
        *403*|*429*) fail "GitHub refused to say what the latest release is, most likely a rate limit." \
          "Wait a few minutes, or name the version yourself with --ref <tag>." ;;
        *404*) fail "No published release was found in $SOURCE_URL." "Pass --ref <tag or branch> to choose a version." ;;
        *) fail "Could not reach GitHub to find the latest release." "Check the internet connection, or pass --ref <tag> and --source <path to a local clone>." ;;
      esac
    fi
    REF="$(printf '%s' "$response" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
    [ -n "$REF" ] || fail "No published release was found in $SOURCE_URL." "Pass --ref <tag or branch> to choose a version."
  fi
fi
echo "-> Installing $REF into $INSTALL_DIR"

mkdir -p "$(dirname "$INSTALL_DIR")" 2>/dev/null || fail "Could not create $(dirname "$INSTALL_DIR")." "Check that you may write there, or pass --dir."
if ! output="$(git clone --quiet --branch "$REF" "$SOURCE_URL" "$INSTALL_DIR" 2>&1)"; then
  rm -rf "$INSTALL_DIR"
  case "$output" in
    *"not found in upstream"*|*"Remote branch"*) fail "$SOURCE_URL has no tag or branch called $REF." "Check the name, or leave --ref out to install the latest release." ;;
    *) fail "Cloning $SOURCE_URL failed." "$output" ;;
  esac
fi
cd "$INSTALL_DIR"

# Cloning a tag leaves a detached HEAD, and an installation needs a real branch:
# work against it is merged into that branch and the engine is restarted onto it.
git symbolic-ref -q HEAD >/dev/null || git checkout --quiet -b installation

# A local clone inherits the local path as its origin. The upstream is what the
# version check compares against, so point origin back at the real repository.
if [ -d "$SOURCE_URL" ]; then
  upstream="$(git -C "$SOURCE_URL" remote get-url origin 2>/dev/null || true)"
  [ -z "$upstream" ] || git remote set-url origin "$upstream"
fi

# From here the checkout exists, and with it the proper checks.
. "$INSTALL_DIR/scripts/preflight.sh"
. "$INSTALL_DIR/scripts/state-root.sh"
. "$INSTALL_DIR/scripts/default-env.sh"
guard_unexpected

STATE_ROOT="${STATE_ROOT:-$(state_root_for "$INSTALL_DIR")}"
ENV_FILE="$STATE_ROOT/env"
if [ -f "$ENV_FILE" ]; then
  warn "$ENV_FILE already exists and was kept." \
    "It belongs to an earlier installation with the same directory name. If this one should start fresh, delete it and run ./scripts/dev-up.sh."
else
  mkdir -p "$STATE_ROOT"
  step "Writing $ENV_FILE"
  write_default_env "$ENV_FILE" "$INSTALL_DIR" "$STATE_ROOT" "${PG_CONTAINER:-ai-engine-postgres-$NAME}"
fi

step "Building"
INSTALL_ROOT="$INSTALL_DIR" STATE_ROOT="$STATE_ROOT" ./scripts/build.sh --source UPSTREAM

# Starting is the same path as starting a clone, with the same checks, rather
# than a second copy of them here.
INSTALL_ROOT="$INSTALL_DIR" STATE_ROOT="$STATE_ROOT" ./scripts/dev-up.sh

if [ -n "$REPO" ]; then
  set -a; . "$ENV_FILE"; set +a
  step "Adding $REPO"
  if ! output="$(curl -sS -X POST "http://localhost:${API_PORT:-4000}/api/projects" \
      -H 'content-type: application/json' -d "{\"repoPath\":\"$REPO\"}" 2>&1)"; then
    warn "The installation is running, but $REPO could not be added." "Add it from the Projects screen instead."
  else
    case "$output" in
      *'"error"'*) warn "The installation is running, but $REPO could not be added." "$output" ;;
    esac
  fi
fi

echo
echo "Everything your projects accumulate lives in the database. The only files"
echo "outside $INSTALL_DIR are in $STATE_ROOT. Deleting the checkout loses nothing."
