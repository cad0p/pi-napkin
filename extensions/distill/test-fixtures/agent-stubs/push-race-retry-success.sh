#!/usr/bin/env bash
# push-race-retry-success.sh — the agent squash-pushes from the worktree,
# loses a non-fast-forward race once, integrates the moved origin in the
# worktree, re-squashes, and pushes successfully on the second attempt.
# The shared vault checkout is never touched.

set -euo pipefail

VAULT="${NAPKIN_STUB_VAULT:?NAPKIN_STUB_VAULT must be set}"
WORKTREE="${NAPKIN_STUB_WORKTREE:?NAPKIN_STUB_WORKTREE must be set}"
DEFAULT_BRANCH="${NAPKIN_STUB_DEFAULT_BRANCH:-main}"
ATTEMPT_FILE="${NAPKIN_STUB_ATTEMPT_FILE:-}"

git -C "$WORKTREE" config user.email "stub@example.com"
git -C "$WORKTREE" config user.name "stub"

echo "# race retried" > "$WORKTREE/race-retried.md"
git -C "$WORKTREE" add -A
git -C "$WORKTREE" commit -m "distill: race retried" >/dev/null

git -C "$WORKTREE" fetch origin "$DEFAULT_BRANCH" >/dev/null 2>&1
git -C "$WORKTREE" merge --no-edit "origin/$DEFAULT_BRANCH" >/dev/null 2>&1 || true
git -C "$WORKTREE" merge --no-edit "$DEFAULT_BRANCH" >/dev/null 2>&1 || true
git -C "$WORKTREE" reset --soft "origin/$DEFAULT_BRANCH"
git -C "$WORKTREE" commit -m "distill: race retried" >/dev/null

# Move origin after the first squash is built but before the first push.
ORIGIN_URL="$(git -C "$WORKTREE" remote get-url origin)"
RACE_CLONE="$(mktemp -d)"
git clone -q "$ORIGIN_URL" "$RACE_CLONE"
git -C "$RACE_CLONE" config user.email "race@example.com"
git -C "$RACE_CLONE" config user.name "race"
echo "# concurrent race" > "$RACE_CLONE/race.md"
git -C "$RACE_CLONE" add race.md
git -C "$RACE_CLONE" commit -m "race: concurrent commit" >/dev/null
git -C "$RACE_CLONE" push origin "$DEFAULT_BRANCH" >/dev/null 2>&1

if git -C "$WORKTREE" push origin "HEAD:$DEFAULT_BRANCH" >/dev/null 2>&1; then
  echo "push-race-retry-success: expected first push to lose the race" >&2
  exit 1
fi

# Retry once in the worktree: fetch, merge the moved origin, re-squash onto
# it, and push HEAD:<default> again. Never pull in the shared checkout.
git -C "$WORKTREE" fetch origin "$DEFAULT_BRANCH" >/dev/null 2>&1
git -C "$WORKTREE" merge --no-edit "origin/$DEFAULT_BRANCH" >/dev/null 2>&1 || true
git -C "$WORKTREE" reset --soft "origin/$DEFAULT_BRANCH"
git -C "$WORKTREE" commit -m "distill: race retried" >/dev/null
git -C "$WORKTREE" push origin "HEAD:$DEFAULT_BRANCH" >/dev/null 2>&1

if [ -n "$ATTEMPT_FILE" ]; then
  printf 'push-attempts=2\n' > "$ATTEMPT_FILE"
fi

# Keep the variable live so fixture readers notice the contract: VAULT is
# deliberately not used by the origin-first path.
printf '%s\n' "$VAULT" >/dev/null
