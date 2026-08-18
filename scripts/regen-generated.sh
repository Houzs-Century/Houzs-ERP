#!/usr/bin/env bash
# Merge driver for docs/generated/* — see .gitattributes.
#
# A generated file has no merge: its content is a function of its source. Take
# the current side so the merge does not stop, then regenerate from source,
# which is the only correct answer. If a generator fails we still exit 0: a
# stale generated file is a warning (check-docs-drift catches it), while a
# blocked merge is the thing this exists to remove.
set -u
export PATH="$HOME/.local/node/bin:$PATH"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 0
npm --prefix backend run gen:bug-index   >/dev/null 2>&1 || true
npm --prefix backend run gen:route-locator >/dev/null 2>&1 || true
node backend/scripts/gen-codebase-map.mjs  >/dev/null 2>&1 || true
exit 0
