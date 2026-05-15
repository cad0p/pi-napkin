#!/usr/bin/env bash
# squash-skipped.sh — agent commits to the distill branch in the
# worktree but never squashes to the default branch. From the vault's
# perspective, the default branch never moved past startSha.
#
# Wrapper outcome: `validate_commit_count` returns 0 (no new commits
# on default) ⇒ `no-content`. The dangling distill branch lives in
# the reflog (recoverable per the recovery hint in `failed:*`
# sidecars; success-class sidecars don't carry recovery hints).
#
# Spec/impl alignment (PR #12 CORR-3, C-R1, resolved Phase D D3):
# design.md's "Mocked-pi behaviors" #5 originally specified `failed`
# for this case. The implementation produces `no-content`, and that's
# the right answer: from main's perspective, no new commits = no
# content was integrated, which is exactly what `no-content` means.
# Adding a new `failed:squash-skipped` reason code would require
# extra wrapper logic to distinguish "agent committed in the worktree
# but didn't squash" from "agent decided nothing was worth
# capturing" — and the wrapper has no signal to tell those apart
# without inspecting the deleted distill branch in the reflog.
# Decision: align spec to impl. design.md will be updated post-merge
# by the orchestrator.
#
# Reads (env): NAPKIN_STUB_WORKTREE

set -euo pipefail

WORKTREE="${NAPKIN_STUB_WORKTREE:?NAPKIN_STUB_WORKTREE must be set}"

git -C "$WORKTREE" config user.email "stub@example.com"
git -C "$WORKTREE" config user.name "stub"
echo "# distill branch only" > "$WORKTREE/dangling.md"
git -C "$WORKTREE" add .
git -C "$WORKTREE" commit -m "distill: branch-only commit (no squash)" >/dev/null
