#!/usr/bin/env bash
# git_retry \u2014 retry a main-mutating git command on transient index.lock
# contention.
#
# Usage:
#   source .../git_retry.sh     # or paste the function body inline
#   git_retry git commit ...
#   git_retry git merge ...
#
# Rationale:
#   pi-napkin's auto-distill writes to the vault's main branch while other
#   processes (Obsidian git plugin, an autocommit cron, manual commands) may
#   also be writing. Git's own `.git/index.lock` serializes these, and a
#   contending write fails with status !=0 and "fatal: Unable to create ...
#   index.lock" on stderr.
#
#   Up to 5 attempts with linear backoff: 0.5s, 1.0s, 1.5s, 2.0s \\u2014 ~5s
#   total worst-case wait (plus command runtime). Good for transient
#   contention; preserves visible failures for real errors (nothing is
#   retried when index.lock isn't the problem, because git's own exit code
#   is deterministic across retries of the same state... in practice,
#   retrying always costs <1s total because contending commits are fast).
#
#   Using a uniform retry (regardless of stderr content) is simpler than
#   parsing; the blast-radius is tiny (~5 extra git invocations), and the
#   alternative (parse stderr for "index.lock") couples us to upstream
#   wording.
#
# Environment override:
#   NAPKIN_GIT_RETRY_MAX  \u2014 override retry count (default 5)
#   NAPKIN_GIT_RETRY_DELAY \u2014 override base delay in seconds (default 0.5)

# Defaults for git_retry. 5 retries \u00d7 0.5s base delay (linear backoff:
# 0.5s + 1.0s + 1.5s + 2.0s = ~5s between attempts, ~7.5s worst-case
# wall wait once the command-runtime fraction is factored in) is long
# enough to outlast typical index.lock contention from the Obsidian git
# plugin / an autocommit cron, while still failing fast on real errors
# (the command is re-run, not the lock specifically, so a deterministic
# failure fails all 5 attempts in roughly the same time).
GIT_RETRY_MAX=5
GIT_RETRY_DELAY_S=0.5

git_retry() {
  local max="${NAPKIN_GIT_RETRY_MAX:-$GIT_RETRY_MAX}"
  local base="${NAPKIN_GIT_RETRY_DELAY:-$GIT_RETRY_DELAY_S}"
  local attempt=1
  local status=0
  while [ "$attempt" -le "$max" ]; do
    "$@"
    status=$?
    if [ "$status" -eq 0 ]; then
      return 0
    fi
    if [ "$attempt" -lt "$max" ]; then
      # sleep base * attempt (shell-float friendly via awk so we don't
      # depend on `bc`, which isn't always installed).
      local secs
      secs=$(awk -v b="$base" -v a="$attempt" 'BEGIN{printf "%.3f", b*a}')
      sleep "$secs"
    fi
    attempt=$((attempt + 1))
  done
  return "$status"
}
