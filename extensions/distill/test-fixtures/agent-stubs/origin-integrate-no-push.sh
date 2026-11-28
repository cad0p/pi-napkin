#!/usr/bin/env bash
# origin-integrate-no-push.sh — correct worktree integration up to the local
# squash commit, but deliberately no push. Wrapper must classify
# failed:push-not-landed because origin/<default> does not contain the commit.

set -euo pipefail

WORKTREE="${NAPKIN_STUB_WORKTREE:?NAPKIN_STUB_WORKTREE must be set}"
DEFAULT_BRANCH="${NAPKIN_STUB_DEFAULT_BRANCH:-main}"

git -C "$WORKTREE" config user.email "stub@example.com"
git -C "$WORKTREE" config user.name "stub"

echo "# integrated but unpushed" > "$WORKTREE/unpushed.md"
git -C "$WORKTREE" add -A
git -C "$WORKTREE" commit -m "distill: unpushed" >/dev/null

git -C "$WORKTREE" fetch origin "$DEFAULT_BRANCH" >/dev/null 2>&1
git -C "$WORKTREE" merge --no-edit "origin/$DEFAULT_BRANCH" >/dev/null 2>&1 || true
git -C "$WORKTREE" merge --no-edit "$DEFAULT_BRANCH" >/dev/null 2>&1 || true
git -C "$WORKTREE" reset --soft "origin/$DEFAULT_BRANCH"
git -C "$WORKTREE" commit -m "distill: unpushed" >/dev/null
