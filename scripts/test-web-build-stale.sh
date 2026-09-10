#!/usr/bin/env bash
# Hermetic test for scripts/web-build-stale.sh. It never runs Next, npm, Docker
# or the network: every case is a fixture tree under a temporary directory with
# every mtime set explicitly, so the result does not depend on filesystem
# timestamp granularity.
#
# Deliberately outside the npm test glob: it must not run inside every apply.
set -uo pipefail

cd "$(dirname "$0")/.."
HELPER="$(pwd)/scripts/web-build-stale.sh"

if [ ! -f "$HELPER" ]; then
  echo "FAIL: scripts/web-build-stale.sh is missing" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

OLD=202601010000
MID=202601020000
NEW=202601030000

failures=0
checked=0
case_no=0

fail() {
  echo "FAIL: $1" >&2
  failures=$((failures + 1))
}

# Builds a fresh fixture: a web directory with sources, build output and
# installed dependencies, all dated OLD, plus a stamp dated MID.
fixture() {
  case_no=$((case_no + 1))
  web="$TMP/case$case_no/apps/web"
  stamp="$TMP/case$case_no/.run/web-build.stamp"
  mkdir -p "$web/app" "$web/components/node_modules" "$web/.next/static" \
    "$web/node_modules/react" "$TMP/case$case_no/.run"
  echo "page" > "$web/app/page.tsx"
  echo "config" > "$web/next.config.mjs"
  echo "button" > "$web/components/button.tsx"
  echo "nested dep" > "$web/components/node_modules/dep.js"
  echo "build id" > "$web/.next/BUILD_ID"
  echo "chunk" > "$web/.next/static/chunk.js"
  echo "dep" > "$web/node_modules/react/index.js"
  echo "lock" > "$TMP/case$case_no/package-lock.json"
  echo "env" > "$TMP/case$case_no/.env.local"
  find "$TMP/case$case_no" -exec touch -t "$OLD" {} +
  : > "$stamp"
  touch -t "$MID" "$stamp"
}

# Runs the helper and checks the exit code, and optionally that stdout mentions
# a path. Every case names itself so a failure points straight at it. The helper
# is invoked through bash, which is how dev-up.sh calls it, so the test exercises
# the real invocation path rather than one that depends on the file mode.
expect() {
  local name="$1" want="$2" mention="$3"
  shift 3
  local out got
  checked=$((checked + 1))
  out="$(bash "$HELPER" "$@" 2>/dev/null)"
  got=$?
  if [ "$got" -ne "$want" ]; then
    fail "$name: expected exit $want, got $got"
    return
  fi
  if [ -n "$mention" ] && ! printf '%s\n' "$out" | grep -qF "$mention"; then
    fail "$name: expected stdout to name $mention, got: $out"
    return
  fi
  echo "ok: $name"
}

# 1. Fresh install: no build output and no stamp.
fixture
rm -rf "$web/.next" "$stamp"
expect "no BUILD_ID and no stamp rebuilds" 0 "" "$web" "$stamp"

# 2. A build ran before this change existed, so there is no stamp yet.
fixture
rm -f "$stamp"
expect "BUILD_ID without a stamp rebuilds" 0 "" "$web" "$stamp"

# 3. The criterion the whole design is shaped around.
fixture
expect "nothing changed skips the build" 1 "" "$web" "$stamp"

# 4. An edited source.
fixture
touch -t "$NEW" "$web/app/page.tsx"
expect "an edited source rebuilds and names the file" 0 "$web/app/page.tsx" "$web" "$stamp"

# 5. Build output is always newer than the stamp and must never count.
fixture
touch -t "$NEW" "$web/.next/static/chunk.js"
expect "build output does not rebuild" 1 "" "$web" "$stamp"

# 6. Installed dependencies do not count either.
fixture
touch -t "$NEW" "$web/node_modules/react/index.js"
expect "installed dependencies do not rebuild" 1 "" "$web" "$stamp"

# 7. npm normally hoists to the root, but a version conflict nests.
fixture
touch -t "$NEW" "$web/components/node_modules/dep.js"
expect "a nested node_modules does not rebuild" 1 "" "$web" "$stamp"

# 8. A new source file.
fixture
echo "new" > "$web/app/layout.tsx"
touch -t "$NEW" "$web/app/layout.tsx" "$web/app"
expect "a new source rebuilds" 0 "$web/app/layout.tsx" "$web" "$stamp"

# 9. A deletion is caught through the parent directory's mtime, which is why
# the comparison is not restricted to regular files.
fixture
rm -f "$web/components/button.tsx"
touch -t "$NEW" "$web/components"
expect "a deleted source rebuilds" 0 "$web/components" "$web" "$stamp"

# 10. The lockfile changes what the bundle contains without touching apps/web.
fixture
touch -t "$NEW" "$TMP/case$case_no/package-lock.json"
expect "an edited extra source rebuilds and names it" 0 "$TMP/case$case_no/package-lock.json" \
  "$web" "$stamp" "$TMP/case$case_no/package-lock.json" "$TMP/case$case_no/.env.local"

# 11. Both extra sources present and older.
fixture
expect "unchanged extra sources skip the build" 1 "" \
  "$web" "$stamp" "$TMP/case$case_no/package-lock.json" "$TMP/case$case_no/.env.local"

# 12. A missing extra source is dropped rather than made into an error.
fixture
expect "a missing extra source is ignored" 1 "" \
  "$web" "$stamp" "$TMP/case$case_no/does-not-exist.json" "$TMP/case$case_no/.env.local"

# 13. Cannot answer.
fixture
expect "a missing web directory cannot answer" 2 "" "$TMP/case$case_no/nowhere" "$stamp"

# 14. Mis-invocation. The caller reads anything but 1 as a rebuild.
expect "no arguments cannot answer" 2 ""

if [ "$failures" -ne 0 ]; then
  echo "$failures case(s) failed" >&2
  exit 1
fi
echo "all $checked cases passed"
