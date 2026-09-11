#!/usr/bin/env bash
# Installs Story Builder.
#
# The engine is cloned from its latest release into its own directory, outside
# any repository it works on. Projects are added afterwards from the cockpit, one
# click each, and a project only ever gains a marker naming the installation that
# serves it.
#
#   ./install.sh
#   ./install.sh --repo /absolute/path/to/a/repository   # adds one immediately
#
# Options:
#   --repo <path>    optionally register this repository straight away
#   --dir <path>     where to install, default ~/.story-builder/story-builder
#   --source <url>   where to install from, a URL or a local checkout
#   --ref <tag>      install this tag or branch instead of the latest release
#   --name <name>    name of the installation
#
set -euo pipefail

SOURCE_URL="${SOURCE_URL:-https://github.com/interval-pro/story-builder.git}"
REPO=""
NAME=""
INSTALL_DIR=""
REF=""

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --source) SOURCE_URL="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# A repository is optional now. An installation serves as many projects as you
# add to it, so installing one with none is normal: you start the cockpit and add
# the first project there.
if [ -n "$REPO" ]; then
  REPO="$(cd "$REPO" && pwd)"
  if ! git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "$REPO is not a Git repository." >&2
    exit 1
  fi
  REPO="$(git -C "$REPO" rev-parse --show-toplevel)"
  NAME="${NAME:-$(basename "$REPO")}"
fi
NAME="${NAME:-story-builder}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.story-builder/$NAME}"

if [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
  echo "$INSTALL_DIR already exists and is not empty." >&2
  echo "Remove it first, or pass --dir to install somewhere else." >&2
  exit 1
fi

# The release is the unit of installation. A local source is allowed so an
# installation can be made from a checkout you already have, with or without a
# network, and the newest tag stands in for the release in that case.
if [ -z "$REF" ]; then
  if [ -d "$SOURCE_URL" ]; then
    echo "-> Reading the newest tag in $SOURCE_URL"
    REF="$(git -C "$SOURCE_URL" tag --list --sort=-v:refname | head -1)"
    if [ -z "$REF" ]; then
      echo "$SOURCE_URL has no tags. Pass --ref <tag or branch> to choose a version." >&2
      exit 1
    fi
  else
    echo "-> Looking up the latest release"
    slug="$(printf '%s' "$SOURCE_URL" | sed -E 's#^.*github\.com[:/]##; s#\.git$##')"
    REF="$(curl -fsSL "https://api.github.com/repos/$slug/releases/latest" \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 || true)"
    if [ -z "$REF" ]; then
      echo "No published release found in $SOURCE_URL, and no --ref was given." >&2
      echo "Pass --ref <tag or branch>, or --source <path> to install from a local checkout." >&2
      exit 1
    fi
  fi
fi
echo "-> Installing $REF into $INSTALL_DIR"

mkdir -p "$(dirname "$INSTALL_DIR")"
git clone --quiet --branch "$REF" "$SOURCE_URL" "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Cloning a tag leaves a detached HEAD, and an installation needs a real branch:
# work against it is merged into that branch and the engine is restarted onto it.
if ! git symbolic-ref -q HEAD >/dev/null; then
  git checkout --quiet -b installation
fi

# A local clone inherits the local path as its origin. The upstream is what the
# version check compares against, so point origin back at the real repository.
if [ -d "$SOURCE_URL" ]; then
  upstream="$(git -C "$SOURCE_URL" remote get-url origin 2>/dev/null || true)"
  if [ -n "$upstream" ]; then
    git remote set-url origin "$upstream"
  fi
fi

echo "-> Installing dependencies"
npm ci --silent

echo "-> Building"
npm run build --silent

if [ ! -f .env.local ]; then
  echo "-> Writing .env.local"
  PG_PORT="${PG_PORT:-5433}"
  {
    echo "INSTALL_ROOT=$INSTALL_DIR"
    echo "STATE_ROOT=$INSTALL_DIR.state"
    echo "WORKSPACES_ROOT=$INSTALL_DIR.state/workspaces"
    echo "ARTIFACTS_ROOT=$INSTALL_DIR.state/artifacts"
    echo "DATABASE_URL=postgres://ai_engine:ai_engine@localhost:$PG_PORT/ai_engine"
    echo "PG_CONTAINER=${PG_CONTAINER:-ai-engine-postgres-$NAME}"
    echo "PG_PORT=$PG_PORT"
    echo "SANDBOX_DOCKER_ENABLED=false"
    echo "AGENT_ENGINE=claude-code"
    echo "AI_PROVIDER=mock"
    echo "API_PORT=4000"
    echo "LOG_LEVEL=info"
  } > .env.local
fi

set -a; . ./.env.local; set +a

echo "-> Postgres"
if ! docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
  docker start "$PG_CONTAINER" >/dev/null 2>&1 || docker run -d --name "$PG_CONTAINER" \
    -e POSTGRES_USER=ai_engine -e POSTGRES_PASSWORD=ai_engine -e POSTGRES_DB=ai_engine \
    -p "${PG_PORT}:5432" postgres:16-alpine >/dev/null
fi
until docker exec "$PG_CONTAINER" pg_isready -U ai_engine -d ai_engine >/dev/null 2>&1; do sleep 1; done

echo "-> Registering the installation"
if [ -n "$REPO" ]; then
  node apps/cli/dist/main.js init --repo "$REPO" --install-root "$INSTALL_DIR"
else
  node apps/cli/dist/main.js init --install-root "$INSTALL_DIR"
fi

echo
echo "Installed. Start it with:"
echo "  cd $INSTALL_DIR && ./scripts/dev-up.sh"
if [ -z "$REPO" ]; then
  echo
  echo "Then open http://localhost:3000 and add the first project."
fi
echo
echo "Worktrees and artifacts live in ${INSTALL_DIR}.state and the database lives in"
echo "the ${PG_CONTAINER} container. Both survive installing a new version, so removing"
echo "$INSTALL_DIR alone is safe."

