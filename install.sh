#!/usr/bin/env bash
# Installs Story Builder as a layer over a project.
#
# The engine is cloned from its latest release into its own directory, outside
# the repository it works on, and the project only gains a marker naming the
# installation that serves it.
#
#   ./install.sh --repo /absolute/path/to/your/repository
#
# Options:
#   --repo <path>    the repository to work on (required)
#   --dir <path>     where to install, default ~/.story-builder/<name>
#   --source <url>   where to install from, a URL or a local checkout
#   --ref <tag>      install this tag or branch instead of the latest release
#   --name <name>    name of the installation, default the repository name
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
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$REPO" ]; then
  echo "Usage: ./install.sh --repo /absolute/path/to/your/repository" >&2
  exit 1
fi

REPO="$(cd "$REPO" && pwd)"
if ! git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "$REPO is not a Git repository." >&2
  exit 1
fi
REPO="$(git -C "$REPO" rev-parse --show-toplevel)"
NAME="${NAME:-$(basename "$REPO")}"
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
    echo "PROJECT_ROOT=$REPO"
    echo "DATABASE_URL=postgres://ai_engine:ai_engine@localhost:$PG_PORT/ai_engine"
    echo "PG_CONTAINER=${PG_CONTAINER:-ai-engine-postgres-$NAME}"
    echo "PG_PORT=$PG_PORT"
    echo "SANDBOX_DOCKER_ENABLED=false"
    echo "AGENT_ENGINE=claude-code"
    echo "AI_PROVIDER=mock"
    echo "API_PORT=4000"
    echo "LOG_LEVEL=info"
    echo "GITHUB_TOKEN="
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

echo "-> Pointing the installation at the project"
node apps/cli/dist/main.js init --repo "$REPO" --install-root "$INSTALL_DIR"

echo
echo "Installed. Start it with:"
echo "  cd $INSTALL_DIR && ./scripts/dev-up.sh"
