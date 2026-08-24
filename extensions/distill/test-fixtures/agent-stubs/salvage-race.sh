#!/usr/bin/env bash
# salvage-race.sh — stub-pi that triggers the wrapper's salvage path
# by leaving a REAL unresolved merge conflict in the vault (git index
# stages 1/2/3), then exits 0.
#
# Used by wrapper-invariant.test.ts's salvage-path case. The stub:
#   1. Creates divergent history and merges it, leaving conflict.md
#      unmerged in the vault's index (so `git ls-files -u` lists it
#      and the conflict validator rejects the run).
#   2. Exits 0 — the stub itself doesn't error; the failure surfaces
#      in the wrapper's post-validation step.
#
# Wrapper response: `validate_no_unresolved_conflicts` finds the
# unmerged path, returns non-zero, and the wrapper enters
# `salvage("markers-after-agent-exit")`. The salvage path:
#   - cd's out of the worktree
#   - removes the worktree (this is the moment the test polls)
#   - composes a recovery hint
#   - writes the `failed:markers-after-agent-exit` outcome sidecar
#
# The wrapper invariant ('write_outcome runs before any worktree-
# removal step anywhere in the wrapper') requires the salvage code to
# write the outcome BEFORE removing the worktree. The test confirms
# this by snapshotting the outcome file at the moment the worktree
# disappears.
#
# Race-window widening: the salvage path's race is INSIDE the wrapper
# itself (between `git worktree remove` returning and `write_outcome`
# being called), so a stub-side `sleep` can't widen it. The test
# instead PATH-shims `git` with `slow-git.sh`, which delays the return
# of `git worktree remove` by 0.5 s AFTER the real removal completes.
#
# Reads (env): NAPKIN_STUB_VAULT, NAPKIN_STUB_WORKTREE,
#              NAPKIN_STUB_BRANCH, NAPKIN_STUB_DEFAULT_BRANCH (default: main)

set -euo pipefail

VAULT="${NAPKIN_STUB_VAULT:?NAPKIN_STUB_VAULT must be set}"
WORKTREE="${NAPKIN_STUB_WORKTREE:?NAPKIN_STUB_WORKTREE must be set}"
BRANCH="${NAPKIN_STUB_BRANCH:?NAPKIN_STUB_BRANCH must be set}"
DEFAULT_BRANCH="${NAPKIN_STUB_DEFAULT_BRANCH:-main}"

git -C "$VAULT" config user.email "stub@example.com"
git -C "$VAULT" config user.name "stub"

# Leave a REAL unresolved merge conflict in the vault. The wrapper's
# conflict validator uses `git ls-files -u` (index stages 1/2/3) — a
# literal marker-text commit would no longer trip it, so we create
# divergent history and merge it without resolving.
git -C "$VAULT" checkout -q -b conflict-side
cat > "$VAULT/distilled-with-markers.md" <<'MD'
# distilled (salvage-race)

This is the local side.
MD
git -C "$VAULT" add distilled-with-markers.md
git -C "$VAULT" commit -q -m "conflict side" >/dev/null
git -C "$VAULT" checkout -q "$DEFAULT_BRANCH"
cat > "$VAULT/distilled-with-markers.md" <<'MD'
# distilled (salvage-race)

This is the incoming side.
MD
git -C "$VAULT" add distilled-with-markers.md
git -C "$VAULT" commit -q -m "conflict main" >/dev/null
git -C "$VAULT" merge conflict-side >/dev/null 2>&1 || true

# Exit cleanly. The wrapper's post-validation will detect the
# unresolved conflict and route into salvage().
