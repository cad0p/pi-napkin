#!/usr/bin/env bash
# committed-markers.sh — issue #122 marker gate.
#
# The agent commits a file that still carries git conflict markers, the
# measured shape behind 54 distill commits / 40 files (the agent git-adds
# an unresolved merge; `git ls-files -u` is then empty, so the old
# post-agent validator passed it by design).
#
# Expected wrapper outcome: `markers-in-content`, default branch tip
# unchanged, distill branch kept.
#
# Reads (env): NAPKIN_STUB_WORKTREE

set -euo pipefail

WORKTREE="${NAPKIN_STUB_WORKTREE:?NAPKIN_STUB_WORKTREE must be set}"

git -C "$WORKTREE" config user.email "stub@example.com"
git -C "$WORKTREE" config user.name "stub"

{
  printf "<<<<<<< HEAD\n"
  printf "branch line\n"
  printf "=======\n"
  printf "main lane line\n"
  printf ">>>>>>> main\n"
} > "$WORKTREE/marked.md"

git -C "$WORKTREE" add -A
git -C "$WORKTREE" commit -q -m "distill: committed an unresolved merge"
