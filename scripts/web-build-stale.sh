#!/usr/bin/env bash
# Decides whether the cockpit needs rebuilding.
#   scripts/web-build-stale.sh <web-dir> <stamp-file> [extra-source ...]
# Exit 1 means the last successful build is still current. Anything else means
# build: being wrong about freshness serves the version of the cockpit from
# before the update, so every uncertain answer falls on the rebuild side.
# No -e: find must be free to exit non-zero on a path that vanished mid-scan
# without killing the check.
set -uo pipefail

web="${1:-}"
stamp="${2:-}"
if [ -z "$web" ] || [ -z "$stamp" ]; then
  echo "usage: web-build-stale.sh <web-dir> <stamp-file> [extra-source ...]" >&2
  exit 2
fi
shift 2
[ -d "$web" ] || exit 2

# A build that failed half way leaves the directory behind without a marker.
[ -f "$web/.next/BUILD_ID" ] || exit 0
[ -f "$stamp" ] || exit 0

# Extra sources are compared exactly like the tree. They live outside apps/web
# but decide what the bundle contains: the lockfile because dependencies hoist
# to the root, the env file because the API base URL is inlined at build time.
# A path that is not there is dropped rather than made into an error.
roots=("$web")
for extra in "$@"; do
  if [ -e "$extra" ]; then roots+=("$extra"); fi
done

# The stamp is written only after a build finishes, so anything the build
# itself rewrote (next-env.d.ts, tsconfig.json) is older than it and does not
# count as a change. Directories are compared too: that is what catches a
# deleted or renamed file.
changed="$(find "${roots[@]}" \
  \( -name .next -o -name node_modules \) -prune -o \
  -newer "$stamp" -print 2>/dev/null)"

[ -z "$changed" ] || { printf '%s\n' "$changed"; exit 0; }
exit 1
