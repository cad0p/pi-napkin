#!/usr/bin/env bash
# readonly-modify.sh — issue #122 read-only gate, modify case.
#
# The agent appends to a PR note (a projection source the vault config
# marks read-only) and creates an ordinary note. Contract: stop at step 7
# — commit in the worktree, never touch the live vault.
#
# Expected wrapper outcome: `merged-content`. The PR note on the default
# branch must be byte-identical to before, the new note must land, the
# warning log must name the dropped path and the refused-patch file must
# exist under <vault>/.napkin/distill/refused/.
#
# Reads (env): NAPKIN_STUB_WORKTREE

set -euo pipefail

WORKTREE="${NAPKIN_STUB_WORKTREE:?NAPKIN_STUB_WORKTREE must be set}"

git -C "$WORKTREE" config user.email "stub@example.com"
git -C "$WORKTREE" config user.name "stub"

printf "distill appended a finding about the PR\n" >> "$WORKTREE/area/prs/pr-1.md"
mkdir -p "$WORKTREE/area/notes"
printf "# new note\n\ncaptured\n" > "$WORKTREE/area/notes/new.md"

git -C "$WORKTREE" add -A
git -C "$WORKTREE" commit -q -m "distill: pr note + new note"
