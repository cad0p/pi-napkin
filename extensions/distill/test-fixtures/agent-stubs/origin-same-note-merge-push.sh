#!/usr/bin/env bash
# origin-same-note-merge-push.sh — origin moved the SAME note the distill
# edited. The agent fetches origin in the worktree, hits the merge conflict
# there, resolves by unioning both sides, squashes onto origin/<default>,
# and pushes. The shared checkout is never touched.

set -euo pipefail

WORKTREE="${NAPKIN_STUB_WORKTREE:?NAPKIN_STUB_WORKTREE must be set}"
DEFAULT_BRANCH="${NAPKIN_STUB_DEFAULT_BRANCH:-main}"

git -C "$WORKTREE" config user.email "stub@example.com"
git -C "$WORKTREE" config user.name "stub"

cat > "$WORKTREE/seed.md" <<'DISTILL'
# seed

distill session line
DISTILL
git -C "$WORKTREE" add -A
git -C "$WORKTREE" commit -m "distill: same note" >/dev/null

git -C "$WORKTREE" fetch origin "$DEFAULT_BRANCH" >/dev/null 2>&1
if git -C "$WORKTREE" merge --no-edit "origin/$DEFAULT_BRANCH" >/dev/null 2>&1; then
  echo "origin-same-note-merge-push: expected a same-note conflict" >&2
  exit 1
fi

cat > "$WORKTREE/seed.md" <<'RESOLVED'
# seed

origin concurrent line
distill session line
RESOLVED
git -C "$WORKTREE" add seed.md
git -C "$WORKTREE" commit --no-edit >/dev/null

git -C "$WORKTREE" reset --soft "origin/$DEFAULT_BRANCH"
git -C "$WORKTREE" commit -m "distill: same note" >/dev/null
git -C "$WORKTREE" push origin "HEAD:$DEFAULT_BRANCH" >/dev/null 2>&1
