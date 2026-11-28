#!/usr/bin/env bash
# local-no-origin-squash.sh — legacy fallback when no origin is configured:
# commit in the worktree, then squash that branch into the shared checkout's
# local default branch.

set -euo pipefail

VAULT="${NAPKIN_STUB_VAULT:?NAPKIN_STUB_VAULT must be set}"
WORKTREE="${NAPKIN_STUB_WORKTREE:?NAPKIN_STUB_WORKTREE must be set}"
BRANCH="${NAPKIN_STUB_BRANCH:?NAPKIN_STUB_BRANCH must be set}"
DEFAULT_BRANCH="${NAPKIN_STUB_DEFAULT_BRANCH:-main}"

git -C "$WORKTREE" config user.email "stub@example.com"
git -C "$WORKTREE" config user.name "stub"
git -C "$VAULT" config user.email "stub@example.com"
git -C "$VAULT" config user.name "stub"

echo "# local no origin" > "$WORKTREE/local-no-origin.md"
git -C "$WORKTREE" add -A
git -C "$WORKTREE" commit -m "distill: local no origin" >/dev/null

git -C "$VAULT" checkout -q "$DEFAULT_BRANCH"
git -C "$VAULT" merge --squash "$BRANCH" >/dev/null 2>&1
git -C "$VAULT" commit -m "distill: local no origin" >/dev/null
