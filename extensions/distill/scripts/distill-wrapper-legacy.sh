#!/usr/bin/env bash
# distill-wrapper-legacy — thin wrapper for the git-optional manual `/distill`
# path. Runs `pi -p <prompt>` against a forked session file and then removes
# the temp dir.
#
# This exists so the legacy spawn path uses argv-based `spawn("sh", [...])`
# semantics matching the worktree wrapper, instead of `sh -c "<string>"` with
# user-controlled interpolation points. Every variable below is a positional
# arg — never interpolated into a shell string — so the only trust boundary
# is the one node:child_process already enforces.
#
# Usage:
#   distill-wrapper-legacy.sh <sessionFile> <tmpDir> <prompt> [<model>]
#
# Arguments:
#   <sessionFile>  absolute path to the forked session .jsonl
#   <tmpDir>       absolute path to the fork's parent dir (removed on exit)
#   <prompt>       prompt passed to `pi -p`
#   <model>        optional "<provider>/<id>" forwarded to `pi --model`
#
# Environment:
#   NAPKIN_DISTILL_NO_RECURSE=1  caller sets this so the inner pi won't
#                                recurse into another distill.
#   NAPKIN_DISTILL_PI_BIN        optional override for tests.
#
# Exit:
#   Always 0 after cleanup. We don't propagate pi's exit code because the
#   parent pi session has already unref'd us; the caller observes completion
#   by polling for the tmpDir's disappearance.

set -u

SESSION_FILE="${1:-}"
TMP_DIR="${2:-}"
PROMPT="${3:-}"
MODEL="${4:-}"

if [ -z "$SESSION_FILE" ] || [ -z "$TMP_DIR" ] || [ -z "$PROMPT" ]; then
  echo "distill-wrapper-legacy: missing required argument" >&2
  exit 2
fi

PI_BIN="${NAPKIN_DISTILL_PI_BIN:-pi}"
pi_args=(--session "$SESSION_FILE" -p "$PROMPT")
if [ -n "$MODEL" ]; then
  # Splice --model <MODEL> before -p.
  pi_args=(--session "$SESSION_FILE" --model "$MODEL" -p "$PROMPT")
fi

# Run pi; ignore its exit code. stdout/stderr silenced — matches the old
# `pi ... >/dev/null 2>&1` behavior.
"$PI_BIN" "${pi_args[@]}" > /dev/null 2>&1 || true

# Clean up the temp dir. Use `rm -rf` via the real binary — no shell string
# interpolation.
rm -rf -- "$TMP_DIR"

exit 0
