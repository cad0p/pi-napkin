#!/usr/bin/env bash
# origin-two-commits.sh — agent implements the two-commit contract (owner
# 2026-11-28): commit (a) is the session autocommit already present in the
# worktree, commit (b) is the distill's own edits, and both are rebuilt
# linearly on top of origin/<default> without squashing them together.
#
# Env: NAPKIN_STUB_WORKTREE, NAPKIN_STUB_DEFAULT_BRANCH,
#      NAPKIN_STUB_EDIT_SESSION_FILE=1 -> also edit the session-written file
#      (its original bytes must stay in commit (a), the edit lands in (b)).

set -euo pipefail

WORKTREE="${NAPKIN_STUB_WORKTREE:?NAPKIN_STUB_WORKTREE must be set}"
DEFAULT_BRANCH="${NAPKIN_STUB_DEFAULT_BRANCH:-main}"
MANIFEST="$WORKTREE/.napkin/distill/session-writes.json"

git -C "$WORKTREE" config user.email "stub@example.com"
git -C "$WORKTREE" config user.name "stub"

AUTOCOMMIT=""
SESSION_PATHS=""
if [ -f "$MANIFEST" ]; then
  AUTOCOMMIT="$(node -e 'const m=require(process.argv[1]); process.stdout.write(m.autocommit||"")' "$MANIFEST")"
  SESSION_PATHS="$(node -e 'const m=require(process.argv[1]); process.stdout.write(m.paths.join(" "))' "$MANIFEST")"
fi

# Distill's own edits (steps 1-6 of the prompt).
echo "# distill two commits" > "$WORKTREE/distill-note.md"
if [ "${NAPKIN_STUB_EDIT_SESSION_FILE:-}" = "1" ]; then
  for p in $SESSION_PATHS; do
    printf 'distill edit\n' >> "$WORKTREE/$p"
  done
fi

# Step 7: commit own work, integrate origin in the worktree.
git -C "$WORKTREE" add -A -- . ":(exclude).napkin/distill/"
git -C "$WORKTREE" commit -m "wip: distill edits" >/dev/null
git -C "$WORKTREE" fetch origin "$DEFAULT_BRANCH" >/dev/null 2>&1
git -C "$WORKTREE" merge --no-edit "origin/$DEFAULT_BRANCH" >/dev/null 2>&1 || true

# Step 8: rebuild two linear commits on top of origin, then push both.
git -C "$WORKTREE" reset --mixed "origin/$DEFAULT_BRANCH"
if [ -n "$AUTOCOMMIT" ]; then
  # shellcheck disable=SC2086
  git -C "$WORKTREE" reset -q "$AUTOCOMMIT" -- $SESSION_PATHS
  git -C "$WORKTREE" commit -m "autocommit: $(echo $SESSION_PATHS | wc -w) files written by session stub" >/dev/null
fi
git -C "$WORKTREE" add -A -- . ":(exclude).napkin/distill/"
if ! git -C "$WORKTREE" diff --cached --quiet; then
  git -C "$WORKTREE" commit -m "distill: two commits" >/dev/null
fi
git -C "$WORKTREE" push origin "HEAD:$DEFAULT_BRANCH" >/dev/null 2>&1
