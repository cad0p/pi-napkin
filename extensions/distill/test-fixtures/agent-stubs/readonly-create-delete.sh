#!/usr/bin/env bash
# readonly-create-delete.sh — issue #122 read-only gate, create + delete.
#
# The agent creates a NEW PR note and DELETES an existing issue note; both
# path classes are read-only, and both are the measured damage shapes
# (35 adds and 5 deletes under prs/issues in Goldmine).
#
# Expected wrapper outcome: `merged-content` with neither path in the
# default branch diff: the new note is removed from the branch, the
# deleted note is restored from the default branch.
#
# Reads (env): NAPKIN_STUB_WORKTREE

set -euo pipefail

WORKTREE="${NAPKIN_STUB_WORKTREE:?NAPKIN_STUB_WORKTREE must be set}"

git -C "$WORKTREE" config user.email "stub@example.com"
git -C "$WORKTREE" config user.name "stub"

mkdir -p "$WORKTREE/area/prs"
printf "# new pr note\n" > "$WORKTREE/area/prs/new-pr.md"
rm -f "$WORKTREE/area/issues/i.md"

git -C "$WORKTREE" add -A
git -C "$WORKTREE" commit -q -m "distill: touch prs and issues"
