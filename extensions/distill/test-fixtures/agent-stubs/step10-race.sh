#!/usr/bin/env bash
# step10-race.sh — happy-path stub for the agent's post-fix integration.
#
# Mirrors a successful distill where the agent:
#   1. Distilled content into the worktree (steps 1–6 of distill-prompt.md)
#   2. Merged main into the distill branch + squash-merged to main (steps 7–9)
#   3. Exits — the wrapper's EXIT trap handles worktree removal
#
# Pre-fix this stub also ran `git worktree remove --force` to mirror the
# agent's old step 10. That code path is gone now (wrapper owns cleanup
# unconditionally), so the stub no longer removes the worktree itself —
# leaving it matches post-fix production behaviour exactly.
#
# We keep `sleep 0.5` AFTER the agent's commit work so the wrapper's
# subsequent post-validation + write_outcome + EXIT-trap cleanup happen
# at a known wall-time offset relative to the JS-side poll. This widens
# the [agent-exit, worktree-removed] gap deterministically for the
# wrapper-invariant happy-path test in `wrapper-invariant.test.ts`,
# letting that test snapshot the outcome-file state at the exact moment
# the worktree disappears.
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

# Steps 7–9 effect: a single squash commit lands on default. We commit
# directly in the vault (not the worktree) because the wrapper post-
# validation only inspects the vault — the distinction doesn't matter
# for the scenario we're stubbing. validate_commit_count will see
# count=1, validate_head_on_default sees HEAD on main, validate_no_markers
# sees no markers, so the wrapper's happy-path outcome is `merged-content`.
echo "# distilled (step10-race)" > "$VAULT/distilled-step10-race.md"
git -C "$VAULT" add .
git -C "$VAULT" commit -m "distill: step10-race squash" >/dev/null

# Race-window widening: keep the agent subprocess alive long enough
# that the wrapper's post-validation + write_outcome + EXIT-trap
# cleanup chain hits a wall-time offset where the JS-side poller's
# 50 ms tick (test) / ~2 s tick (production) reliably observes the
# transition between worktree-present and worktree-removed. Used by
# both `race-step10-cleanup.test.ts` and the happy-path case in
# `wrapper-invariant.test.ts`.
sleep 0.5
