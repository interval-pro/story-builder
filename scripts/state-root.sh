#!/usr/bin/env bash
# Where this installation keeps what has to be a file.
#
# One directory under the home directory, one level down. The checkout holds
# code and nothing else, so it can be deleted and cloned again without losing
# anything. This must agree exactly with stateRootFor() in
# packages/shared/src/paths.ts: the scripts and the services resolve the same
# path independently, and a disagreement means the cockpit reads a different
# build.json from the one the start script wrote.
#
# Usage: state_root_for /path/to/checkout
state_root_for() {
  local name
  name="$(basename "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]\{1,\}/-/g')"
  if [ "$name" = "story-builder" ] || [ -z "$name" ]; then
    printf '%s/.story-builder' "$HOME"
  else
    printf '%s/.story-builder-%s' "$HOME" "$name"
  fi
}
