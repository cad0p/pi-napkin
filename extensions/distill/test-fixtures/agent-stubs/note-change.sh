#!/usr/bin/env bash
# note-change.sh — minimal step-7 contract fixture.
#
# Commits one ordinary note change on the distill branch and stops. Used by
# the dirty-path, staged-index and push-race tests, which vary the LIVE
# vault state instead of the agent behaviour.
#
# Reads (env): NAPKIN_STUB_WORKTREE, NAPKIN_STUB_NOTE (default notes/touched.md)

set -euo pipefail

WORKTREE="${NAPKIN_STUB_WORKTREE:?NAPKIN_STUB_WORKTREE must be set}"
NOTE="${NAPKIN_STUB_NOTE:-notes/touched.md}"

git -C "$WORKTREE" config user.email "stub@example.com"
git -C "$WORKTREE" config user.name "stub"

mkdir -p "$(dirname "$WORKTREE/$NOTE")"
printf "distilled line\n" >> "$WORKTREE/$NOTE"

git -C "$WORKTREE" add -A
git -C "$WORKTREE" commit -q -m "distill: note change"
