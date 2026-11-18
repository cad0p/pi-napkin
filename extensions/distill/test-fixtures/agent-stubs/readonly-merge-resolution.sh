#!/usr/bin/env bash
# readonly-merge-resolution.sh — issue #122 read-only gate, the sneaky path.
#
# Writes the PR note on the branch, a concurrent lane writes the same note
# on the default branch, and the agent resolves the catch-up merge in the
# BRANCH favour (i.e. it "resolves" the conflict into its own edit of a
# read-only note). Resolving a conflict is a write; the tree-diff gate must
# judge the RESULT, not the command that produced it.
#
# Expected wrapper outcome: `merged-content` with the PR note on the
# default branch byte-identical to the concurrent lane version.
#
# Reads (env): NAPKIN_STUB_VAULT, NAPKIN_STUB_WORKTREE, NAPKIN_STUB_DEFAULT_BRANCH

set -euo pipefail

VAULT="${NAPKIN_STUB_VAULT:?NAPKIN_STUB_VAULT must be set}"
WORKTREE="${NAPKIN_STUB_WORKTREE:?NAPKIN_STUB_WORKTREE must be set}"
DEFAULT_BRANCH="${NAPKIN_STUB_DEFAULT_BRANCH:-main}"

for repo in "$VAULT" "$WORKTREE"; do
  git -C "$repo" config user.email "stub@example.com"
  git -C "$repo" config user.name "stub"
done

# (a) the agent edits the read-only note on its branch.
printf "branch: distill rewrote this note\n" >> "$WORKTREE/area/prs/pr-1.md"
git -C "$WORKTREE" add -A
git -C "$WORKTREE" commit -q -m "distill: pr note edit"

# (b) another lane lands a different edit to the same note on main.
printf "main: lane kept this line\n" >> "$VAULT/area/prs/pr-1.md"
git -C "$VAULT" add -A
git -C "$VAULT" commit -q -m "lane: edit pr note"

# (c) catch up; the note conflicts; resolve in the branch favour.
git -C "$WORKTREE" merge --no-edit "$DEFAULT_BRANCH" >/dev/null 2>&1 || true
git -C "$WORKTREE" checkout --ours -- area/prs/pr-1.md
git -C "$WORKTREE" add -A
git -C "$WORKTREE" commit -q --no-edit -m "merge: resolve in branch favour"
