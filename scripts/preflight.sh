#!/usr/bin/env bash
# What the start, stop, build and install scripts say when something is wrong.
#
# Every failure a person can hit before the cockpit is up ends here, in one
# shape: what happened, then what to do about it, then the evidence. The shape
# matters more than any single message. A script that dies with a raw npm trace,
# or hangs on a Postgres that will never answer, leaves the person to work out
# which of six things went wrong; one that says "port 5433 is taken by process
# 812, postgres, from another project" has already done that work.
#
# Written for the bash macOS ships, which is 3.2: no associative arrays, no
# lowercase expansion, no `timeout`.

if [ -t 2 ]; then
  PF_RED=$'\033[31m'; PF_YELLOW=$'\033[33m'; PF_DIM=$'\033[2m'; PF_RESET=$'\033[0m'
else
  PF_RED=''; PF_YELLOW=''; PF_DIM=''; PF_RESET=''
fi

step() { echo "-> $*"; }

# The net under everything else. A step that fails in a way no check above it
# anticipated must still not end the script silently: a start that prints
# "-> Postgres" and exits 1 with nothing after it is the worst message there is.
# Installed by each script with `guard_unexpected`.
unexpected_failure() {
  local line="$1" command="$2" script="${3:-$0}"
  {
    echo
    echo "${PF_RED}✗ $(basename "$script") stopped unexpectedly at line $line.${PF_RESET}"
    echo "  This is a gap in the script's own checks rather than something you did wrong."
    echo "  The command that failed is below. Running it by hand usually shows why."
    echo
    echo "  ${PF_DIM}│${PF_RESET} $command"
    echo
  } >&2
}
guard_unexpected() {
  set -E
  trap 'unexpected_failure "$LINENO" "$BASH_COMMAND"' ERR
}

# fail "what happened" "what to do" [evidence...]
fail() {
  local what="$1" todo="${2:-}"
  shift 2 2>/dev/null || shift $#
  {
    echo
    echo "${PF_RED}✗ ${what}${PF_RESET}"
    [ -n "$todo" ] && printf '%s\n' "$todo" | sed 's/^/  /'
    if [ $# -gt 0 ]; then
      echo
      printf '%s\n' "$@" | sed "s/^/  ${PF_DIM}│${PF_RESET} /"
    fi
    echo
  } >&2
  exit 1
}

# warn "what happened" "what to do"
warn() {
  {
    echo "${PF_YELLOW}! $1${PF_RESET}"
    [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/  /'
  } >&2
}

# The last lines of a log, for the evidence part of a failure.
log_tail() {
  local file="$1" lines="${2:-15}"
  if [ -s "$file" ]; then
    tail -n "$lines" "$file"
    echo "(full log: $file)"
  else
    echo "(nothing was written to $file)"
  fi
}

need_command() {
  local name="$1" hint="$2"
  command -v "$name" >/dev/null 2>&1 || fail "$name is not installed, or it is not on your PATH." "$hint"
}

need_node() {
  local minimum="$1" version major
  need_command node "Install Node.js $minimum or newer from https://nodejs.org, then run this again."
  need_command npm "npm ships with Node.js. Reinstall Node.js $minimum or newer from https://nodejs.org."
  version="$(node --version 2>/dev/null || true)"
  major="$(printf '%s' "$version" | sed -E 's/^v([0-9]+).*/\1/')"
  case "$major" in
    ''|*[!0-9]*) fail "Could not tell which Node.js this is." "Check that \`node --version\` works in this terminal." "node --version printed: ${version:-nothing}" ;;
  esac
  if [ "$major" -lt "$minimum" ]; then
    fail "Node.js $version is too old. This needs $minimum or newer." \
      "Install a newer Node.js from https://nodejs.org, or switch with your version manager, then run this again."
  fi
}

need_docker() {
  need_command docker "Install Docker Desktop from https://www.docker.com/products/docker-desktop, start it, then run this again.
Postgres runs in a container, so nothing starts without it."
  local output
  if ! output="$(docker version --format '{{.Server.Version}}' 2>&1)"; then
    case "$output" in
      *permission*|*Permission*)
        fail "Docker is installed, but this user may not talk to it." \
          "Add yourself to the docker group, or run Docker Desktop as this user." "$output" ;;
      *)
        fail "Docker is installed but not running." \
          "Start Docker Desktop, wait until it says it is running, then run this again." "$output" ;;
    esac
  fi
}

# Which process is listening on a port, as "pid command", or nothing.
port_holder() {
  local port="$1" pid
  command -v lsof >/dev/null 2>&1 || return 0
  pid="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  [ -n "$pid" ] || return 0
  printf '%s %s' "$pid" "$(ps -o command= -p "$pid" 2>/dev/null | cut -c1-120)"
}

# Whether a process was started from inside this checkout.
#
# Asked of the process's working directory rather than of its command line,
# because two checkouts run the very same `node apps/api/dist/main.js`, and a
# stop script that matches on that kills the other one too.
owned_by_checkout() {
  local pid="$1" root="$2" cwd
  command -v lsof >/dev/null 2>&1 || return 1
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true)"
  case "$cwd" in
    "$root"|"$root"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# wait_until <seconds> <command...>; returns non-zero if it never succeeded.
wait_until() {
  local seconds="$1"; shift
  local waited=0
  until "$@" >/dev/null 2>&1; do
    [ "$waited" -ge "$seconds" ] && return 1
    sleep 1
    waited=$((waited + 1))
  done
}

# An env file is sourced as shell, so a stray line in it is executed. Checked
# before sourcing: every line is a comment, blank, or NAME=value.
check_env_file() {
  local file="$1" bad
  [ -r "$file" ] || fail "$file exists but cannot be read." "Check its permissions: ls -l \"$file\""
  bad="$(grep -nvE '^[[:space:]]*(#.*)?$|^[A-Za-z_][A-Za-z0-9_]*=' "$file" | head -3 || true)"
  if [ -n "$bad" ]; then
    fail "$file has lines that are not settings." \
      "Every line must be NAME=value or a comment. Fix or delete these lines, or delete the file to have the defaults written again." \
      "$bad"
  fi
}

# The port in a postgres:// URL, or nothing.
url_port() {
  printf '%s' "$1" | sed -nE 's#^postgres(ql)?://[^@/]*@?[^:/]*:([0-9]+)/.*#\2#p'
}
