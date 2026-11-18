#!/usr/bin/env bash
# daily-union-merge.sh — issue #122 union merge for daily notes (Q3).
#
# Both the distill branch and a concurrent lane append a line to the same
# daily note. Daily notes are append logs, so the wrapper catch-up merge
# runs with `**/daily/*.md merge=union`: both lines land and no agent is
# asked to resolve a file neither side should lose (28 of the 40 files
# measured with committed markers were dailies).
#
# Expected wrapper outcome: `merged-content` with BOTH lines on the default
# branch and no marker anywhere.
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

# (a) the agent appends its line to today daily note.
printf "distill: captured the session\n" >> "$WORKTREE/area/daily/2026-01-02.md"
git -C "$WORKTREE" add -A
git -C "$WORKTREE" commit -q -m "distill: daily line"

# (b) another lane appends its own line after the agent step 7.
printf "lane: landed a review\n" >> "$VAULT/area/daily/2026-01-02.md"
git -C "$VAULT" add -A
git -C "$VAULT" commit -q -m "lane: daily line"
