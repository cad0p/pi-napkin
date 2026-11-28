#!/usr/bin/env bash
# pushed-success.sh — origin-first happy path. The agent commits in the
# distill worktree, fetches and merges origin/<default> there, squashes to
# one commit on top of origin/<default>, and pushes HEAD:<default>. The
# shared vault checkout is intentionally untouched.
#
# Wrapper outcome: origin/<default> contains the worktree squash commit ⇒
# merged-content.
#
# Reads (env): NAPKIN_STUB_WORKTREE, NAPKIN_STUB_DEFAULT_BRANCH

set -euo pipefail

WORKTREE="${NAPKIN_STUB_WORKTREE:?NAPKIN_STUB_WORKTREE must be set}"
DEFAULT_BRANCH="${NAPKIN_STUB_DEFAULT_BRANCH:-main}"

git -C "$WORKTREE" config user.email "stub@example.com"
git -C "$WORKTREE" config user.name "stub"

echo "# pushed" > "$WORKTREE/pushed.md"
git -C "$WORKTREE" add -A
git -C "$WORKTREE" commit -m "distill: pushed" >/dev/null

git -C "$WORKTREE" fetch origin "$DEFAULT_BRANCH" >/dev/null 2>&1
git -C "$WORKTREE" merge --no-edit "origin/$DEFAULT_BRANCH" >/dev/null 2>&1 || true
git -C "$WORKTREE" merge --no-edit "$DEFAULT_BRANCH" >/dev/null 2>&1 || true

git -C "$WORKTREE" reset --soft "origin/$DEFAULT_BRANCH"
git -C "$WORKTREE" commit -m "distill: pushed" >/dev/null
git -C "$WORKTREE" push origin "HEAD:$DEFAULT_BRANCH" >/dev/null 2>&1
