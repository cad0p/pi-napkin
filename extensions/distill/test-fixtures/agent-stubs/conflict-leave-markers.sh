#!/usr/bin/env bash
# conflict-leave-markers.sh — agent hits a merge conflict and leaves it
# UNRESOLVED in the vault (git index stages 1/2/3). Wrapper
# post-validation detects the unresolved conflict via `git ls-files -u`
# and dispatches `failed:markers-after-agent-exit`.
#
# Reads (env): NAPKIN_STUB_VAULT, NAPKIN_STUB_DEFAULT_BRANCH

set -euo pipefail

VAULT="${NAPKIN_STUB_VAULT:?NAPKIN_STUB_VAULT must be set}"
DEFAULT_BRANCH="${NAPKIN_STUB_DEFAULT_BRANCH:-main}"

git -C "$VAULT" config user.email "stub@example.com"
git -C "$VAULT" config user.name "stub"

# Create divergent history on a side branch, then merge it into the
# default branch so git records stages 1/2/3 in the index for
# conflict.md (a REAL unresolved merge — not just marker text).
git -C "$VAULT" checkout -q -b conflict-side
echo "side content" > "$VAULT/conflict.md"
git -C "$VAULT" add conflict.md
git -C "$VAULT" commit -q -m "conflict side" >/dev/null
git -C "$VAULT" checkout -q "$DEFAULT_BRANCH"
echo "main content" > "$VAULT/conflict.md"
git -C "$VAULT" add conflict.md
git -C "$VAULT" commit -q -m "conflict main" >/dev/null
# Merge is expected to fail (conflict) — leave the index unmerged.
git -C "$VAULT" merge conflict-side >/dev/null 2>&1 || true
