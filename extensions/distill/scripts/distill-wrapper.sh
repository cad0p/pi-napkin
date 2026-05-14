#!/usr/bin/env bash
# distill-wrapper — orchestrates a single auto-distill attempt inside a
# per-distill git worktree.
#
# Usage:
#   distill-wrapper.sh <vault> <worktree> <branch> <sessionFork> <prompt> <errorDir> [<model>] [<defaultBranch>] [<parentCwd>]
#
# Arguments:
#   <vault>         absolute path to the main vault (NOT the worktree)
#   <worktree>      absolute path to the distill worktree (lives under
#                   `$XDG_CACHE_HOME/napkin-distill/<vault-hash>/<suffix>/`;
#                   see `resolveCacheRoot` in extensions/distill/distill-workspace.ts)
#   <branch>        distill branch name (`distill/<hex>-<epoch>`)
#   <sessionFork>   absolute path to the forked session .jsonl inside the worktree
#   <prompt>        prompt passed to `pi -p`
#   <errorDir>      absolute path to `<vault.configPath>/distill/errors/`
#   <model>         optional "<provider>/<id>" to pass to `pi --model`
#   <defaultBranch> optional name of the vault's mainline branch (e.g. `main`,
#                   `master`). When empty/absent, defaults to `main`. The JS
#                   side resolves this via `git symbolic-ref refs/remotes/origin/HEAD`
#                   or a HEAD-ref lookup so the wrapper doesn't hardcode `main`.
#   <parentCwd>     REQUIRED. Absolute path of the parent pi session's cwd.
#                   Pi is spawned at this cwd so the system prompt's
#                   `Current working directory:` line is byte-identical
#                   to the parent's, preserving prompt-cache hits. Vault
#                   writes are still routed to the worktree via the
#                   napkin shim installed at
#                   `<worktree>/.napkin/distill/bin/napkin`. The wrapper
#                   hard-fails if this is empty (R7-PERF-7, R7-CI-6) —
#                   silently falling back to <worktree> would re-
#                   introduce the cache regression POST-R6-CACHE fixed.
#
# Lifecycle (happy path):
#   1. install napkin shim at <worktree>/.napkin/distill/bin/napkin and
#      prepend it to PATH (auto-routes agent napkin calls to the worktree)
#   2. cd <parentCwd>                            (cache parity — keeps pi's
#                                                 system prompt cwd line
#                                                 byte-identical to parent's)
#   3. pi --session <sessionFork> -p <prompt>    (with NAPKIN_DISTILL_NO_RECURSE=1)
#   4. git -C <worktree> add -A
#   5. git -C <worktree> commit -m "distill: …"  (skipped if nothing changed)
#   6. git_retry git -C <worktree> merge main    (LLM merge driver handles *.md
#                                                 conflicts; 3-strike salvage
#                                                 reverts unresolvable files to
#                                                 main's version)
#   7. cd <vault>
#   8. git_retry git merge --squash <branch>
#   9. git_retry git commit -m "<msg>"           (skipped if squash produced no change)
#  10. cleanup (trap): git worktree remove --force, git branch -D
#      (also removes the shim, which lives inside the worktree)
#
# Error handling:
#   Any fatal failure writes a log entry to:
#     <errorDir>/<ISO-timestamp>-<pid>-<branch-short-hash>.log
#   and proceeds to cleanup. We never `exit` before the trap so worktrees and
#   branches are always torn down.
#
# Environment:
#   NAPKIN_DISTILL_NO_RECURSE=1  exported so the nested `pi` won't auto-distill
#   NAPKIN_GIT_RETRY_MAX         forwarded to git_retry
#   NAPKIN_GIT_RETRY_DELAY       forwarded to git_retry
#
# Testing hooks:
#   NAPKIN_DISTILL_PI_BIN        path to a stub `pi` binary (integration tests)
#   NAPKIN_DISTILL_MERGE_MOCK    forwarded to the merge driver
#   NAPKIN_DISTILL_SKIP_PI=1     skip the pi invocation entirely; distill
#                                wrapper instead expects tests to pre-stage any
#                                file changes into the worktree.
#   NAPKIN_DISTILL_HALT_AFTER_META=1
#                                halt right after rewriting meta.json's pid to
#                                the wrapper's pid — lets tests inspect the
#                                updated meta without the cleanup trap
#                                wiping the worktree.
#   NAPKIN_DISTILL_HALT_AFTER_SHIM=1
#                                halt right after the per-distill napkin shim
#                                is installed at <worktree>/.napkin/distill/bin/napkin
#                                — lets tests inspect the shim contents and PATH
#                                injection without the cleanup trap wiping it.
#   NAPKIN_DISTILL_FORCE_MERGE_HEAD=1
#                                force MERGE_HEAD to exist right before the
#                                escape-hatch check — lets tests cover the
#                                belt-and-braces "merge did not complete"
#                                bail-out path, which isn't reliably
#                                triggerable via real driver output.
#   NAPKIN_DISTILL_FORCE_MERGE_RC=<n>
#                                override the captured merge exit code —
#                                lets tests cover the unexpected-exit-code
#                                branch (128 etc.) without contriving a
#                                real git failure of that shape.

set -uo pipefail

# Resolve our own script dir so we can source git_retry.sh regardless of cwd.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./git_retry.sh
source "$HERE/git_retry.sh"

VAULT="${1:-}"
WORKTREE="${2:-}"
BRANCH="${3:-}"
SESSION_FORK="${4:-}"
PROMPT="${5:-}"
ERROR_DIR="${6:-}"
MODEL="${7:-}"
DEFAULT_BRANCH="${8:-main}"
PARENT_CWD="${9:-}"
# Treat empty string as "use fallback", not "literal empty branch name".
if [ -z "$DEFAULT_BRANCH" ]; then
  DEFAULT_BRANCH="main"
fi
# parentCwd (arg 9) is required since POST-R6-CACHE: pi spawns at
# parentCwd to keep the system prompt's `Current working directory:`
# line byte-identical to the parent's, preserving prompt-cache hits.
# Falling back silently to $WORKTREE (pre-R7) re-introduces the cache
# regression with no observable signal — hard-fail instead so any
# out-of-tree caller surfaces the contract violation immediately.
# (R7-PERF-7, R7-CI-6.)
if [ -z "$PARENT_CWD" ]; then
  echo "distill-wrapper: missing required argument 9 (parentCwd) — cache-preserving spawn requires the parent pi session's cwd" >&2
  exit 2
fi

if [ -z "$VAULT" ] || [ -z "$WORKTREE" ] || [ -z "$BRANCH" ] || \
   [ -z "$SESSION_FORK" ] || [ -z "$PROMPT" ] || [ -z "$ERROR_DIR" ]; then
  echo "distill-wrapper: missing required argument" >&2
  exit 2
fi

# Compute error log path. `branch-short-hash` is the portion after `distill/`
# (already unique per invocation — hex nonce + epoch).
BRANCH_SHORT="${BRANCH#distill/}"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ERROR_LOG="$ERROR_DIR/${TIMESTAMP}-$$-${BRANCH_SHORT}.log"

# Lazy-create error log on first write. Empty file is the "no error" signal.
ERROR_LOG_TOUCHED=0
log_error() {
  if [ "$ERROR_LOG_TOUCHED" -eq 0 ]; then
    mkdir -p "$ERROR_DIR"
    {
      echo "# napkin distill error log"
      echo "branch: $BRANCH"
      echo "vault: $VAULT"
      echo "worktree: $WORKTREE"
      echo "started: $TIMESTAMP"
      echo "pid: $$"
      echo
    } >> "$ERROR_LOG"
    ERROR_LOG_TOUCHED=1
  fi
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$ERROR_LOG"
}

# Capture the dangling commit SHA for forensic recovery (git gc grace period
# is 2 weeks by default; `git reflog` holds 90 days). Printed into the error
# log on any fatal failure path so the user can `git cat-file -p <sha>` to
# resurrect the distill's work.
record_dangling_sha() {
  local sha
  sha="$(git -C "$WORKTREE" rev-parse HEAD 2>/dev/null || true)"
  if [ -n "$sha" ]; then
    log_error "dangling distill commit SHA: $sha"
  fi
}

# Trap-based cleanup: always remove the worktree + branch on exit (success or
# failure). `git worktree remove --force` also handles partially-initialized
# worktrees. Errors from cleanup are logged but don't affect our exit status.
cleanup() {
  local rc=$?
  # cd out of the worktree before removing it, otherwise git refuses.
  cd "$VAULT" 2>/dev/null || cd /
  if [ -d "$WORKTREE" ]; then
    git -C "$VAULT" worktree remove --force "$WORKTREE" 2>/dev/null || true
  fi
  # Prune in case the worktree entry is stale but the dir is gone.
  git -C "$VAULT" worktree prune 2>/dev/null || true
  # -D (force) because the distill branch is never marked "merged" (we use
  # squash merge on main, which leaves the branch dangling).
  git -C "$VAULT" branch -D "$BRANCH" 2>/dev/null || true
  exit "$rc"
}
trap cleanup EXIT

# --- Update meta.json's pid to OUR pid ($$) -----------------------------------
#
# createDistillWorkspace() writes meta.json before this wrapper starts, with
# `pid` set to the parent pi session's pid — a pre-spawn placeholder. For
# liveness checks in `getActiveDistills` / `cleanupStaleWorktrees` to be
# accurate, the recorded pid must track THIS wrapper's lifetime: when this
# process dies, the worktree is defunct; when it runs, the worktree is live.
# Rewrite the pid field in place before doing anything else.
#
# The JSON is produced by node's JSON.stringify(obj, null, 2), so the `pid`
# line always has the shape `  "pid": <number>,`. A targeted sed replaces
# just that line. We use a temp file + mv for atomicity (cheap since it's
# same-filesystem).
META_PATH="$WORKTREE/.napkin/distill/meta.json"
if [ -f "$META_PATH" ]; then
  META_TMP="$META_PATH.tmp.$$"
  if sed -E "s/(\"pid\":[[:space:]]*)[0-9]+/\1$$/" "$META_PATH" > "$META_TMP"; then
    mv "$META_TMP" "$META_PATH"
  else
    rm -f "$META_TMP"
    log_error "failed to rewrite meta.json pid to wrapper pid ($$)"
  fi
fi

# Testing hook: halt right after the meta-pid rewrite so integration tests
# can inspect the updated meta.json before the cleanup trap removes the
# worktree. Clears the EXIT trap so cleanup is skipped.
if [ "${NAPKIN_DISTILL_HALT_AFTER_META:-}" = "1" ]; then
  trap - EXIT
  exit 0
fi

# --- Install per-distill napkin shim that auto-routes to the worktree -------
#
# Pi runs at PARENT_CWD (not the worktree) to keep the system prompt's
# `Current working directory:` line byte-identical to the parent's,
# preserving prompt-cache hits across the spawn boundary. That means
# napkin's cwd-based vault walk-up resolves to the *parent's* vault
# (typically the same one we want, but the writes need to land in the
# worktree's checkout for the squash-merge step to see them).
#
# The shim transparently injects `--vault $WORKTREE` into every napkin
# invocation from the agent's bash tool. The real napkin path is
# resolved here (via `command -v`) and baked in as an absolute path —
# so the shim, once invoked, doesn't depend on PATH lookup. PATH
# ordering is still required to ensure the agent's shell resolves
# `napkin` to THIS shim and not the global one: that's what the
# `export PATH="$SHIM_DIR:$PATH"` further down handles.
#
# Lives at `<worktree>/.napkin/distill/bin/napkin` so it's removed when
# the worktree is removed (no extra cleanup needed). The directory is
# already `.gitignore`d via the `.napkin/distill/` exclusion.
#
# Platform note: same bash dependency as the rest of this wrapper. The
# shim itself is a 3-line bash script; works wherever the wrapper does
# (Linux, macOS, WSL, Git Bash). Doesn't add a new platform constraint.
#
# CI / test note: when NAPKIN_DISTILL_SKIP_PI=1 the shim is skipped
# (no pi run → no napkin invocations to route). Lets the integration
# tests run in environments where napkin isn't installed (e.g. fresh
# CI runners). Production never sets SKIP_PI.
#
# See POST-R6-CACHE in features/pi-napkin-distill/deferred.md for the
# full design rationale.
if [ "${NAPKIN_DISTILL_SKIP_PI:-}" != "1" ]; then
  SHIM_DIR="$WORKTREE/.napkin/distill/bin"
  REAL_NAPKIN="$(command -v napkin || true)"
  if [ -z "$REAL_NAPKIN" ]; then
    # Include $PATH in the error log so the user can diagnose missing
    # PATH entries (e.g. cron / systemd / launchd-launched pi with a
    # stripped PATH) without further trial. The error log is vault-local
    # and never leaves the user's machine.
    log_error "napkin binary not found on wrapper PATH; cache-preserving shim cannot be installed"
    log_error "  PATH=$PATH"
    exit 1
  fi
  # Refuse to install on top of another distill shim (recursion footgun:
  # an inherited PATH from an aborted run could leave a stale shim ahead
  # of the real napkin, and the new shim would exec the OLD shim, which
  # exec's the real napkin with a stale --vault — multi-hop indirection
  # at every napkin call). The pattern matches our own shim path layout.
  case "$REAL_NAPKIN" in
    */.napkin/distill/bin/napkin)
      log_error "refusing to install shim — \`command -v napkin\` resolved to another distill shim ($REAL_NAPKIN); check PATH for a stale .napkin/distill/bin/ entry"
      log_error "  PATH=$PATH"
      exit 1
      ;;
  esac
  # Smoke-test that the resolved napkin actually executes. `command -v`
  # only verifies PATH resolution; bun installs napkin as a symlink to
  # `dist/main.js` with `#!/usr/bin/env node` shebang, which fails at
  # exec time if `node` isn't on PATH. Catching that here surfaces a
  # clean diagnostic instead of cryptic "node: not found" on every
  # agent napkin call.
  if ! "$REAL_NAPKIN" --version >/dev/null 2>&1; then
    log_error "napkin not runnable on wrapper PATH (resolved to '$REAL_NAPKIN'); cache-preserving shim cannot be installed"
    log_error "  PATH=$PATH"
    exit 1
  fi
  if ! mkdir -p "$SHIM_DIR"; then
    log_error "failed to mkdir shim dir: $SHIM_DIR"
    exit 1
  fi
  # Generate the shim with `printf %q` so $REAL_NAPKIN and $WORKTREE are
  # shell-escaped at install time. This is escape-safe: any `"`, `\`,
  # `$`, or backtick in either path is quoted so the resulting shim is
  # always well-formed. Plain heredoc-with-interpolation (used
  # previously) was a latent injection surface — see R7-SC-2 / R7-CI-4
  # in features/pi-napkin-distill/pr-11/reviews/.
  if ! {
    printf '#!/usr/bin/env bash\n'
    printf '# Auto-generated distill napkin shim. Routes every napkin command\n'
    printf '# to the distill worktree so vault writes from the agent'\''s bash\n'
    printf '# tool land inside the worktree even though pi'\''s cwd is the\n'
    printf '# parent session'\''s cwd (set that way to preserve prompt-cache\n'
    printf '# hits). Removed when the worktree is removed.\n'
    printf 'exec %q --vault %q "$@"\n' "$REAL_NAPKIN" "$WORKTREE"
  } > "$SHIM_DIR/napkin"; then
    log_error "failed to write shim to $SHIM_DIR/napkin"
    exit 1
  fi
  if ! chmod +x "$SHIM_DIR/napkin"; then
    log_error "failed to chmod +x shim: $SHIM_DIR/napkin"
    exit 1
  fi
  export PATH="$SHIM_DIR:$PATH"
fi

# Testing hook: halt right after the shim install so tests can inspect the
# shim file without the cleanup trap wiping the worktree. Clears the EXIT
# trap so cleanup is skipped — caller is responsible for tearing down the
# worktree afterward.
if [ "${NAPKIN_DISTILL_HALT_AFTER_SHIM:-}" = "1" ]; then
  trap - EXIT
  exit 0
fi

# --- Step 1: run pi at PARENT_CWD (cache parity) -----------------------------
#
# pi reads its session-fork header to determine cwd for the system
# prompt and tools. createDistillWorkspace forked the session with
# `targetCwd = PARENT_CWD` precisely so this matches. Spawning pi here
# at PARENT_CWD also makes process.cwd() consistent with the header,
# which avoids `MissingSessionCwdError` if pi ever validates that.

cd "$PARENT_CWD" || { log_error "cd parent cwd failed: $PARENT_CWD"; exit 1; }

if [ "${NAPKIN_DISTILL_SKIP_PI:-}" != "1" ]; then
  PI_BIN="${NAPKIN_DISTILL_PI_BIN:-pi}"
  pi_args=(--session "$SESSION_FORK")
  if [ -n "$MODEL" ]; then
    pi_args+=(--model "$MODEL")
  fi
  pi_args+=(-p "$PROMPT")
  # Capture pi's stderr into the error log on non-zero exit. stdout is
  # discarded — pi's subagent chatter isn't useful forensically.
  pi_stderr="$(mktemp)"
  if ! NAPKIN_DISTILL_NO_RECURSE=1 "$PI_BIN" "${pi_args[@]}" > /dev/null 2> "$pi_stderr"; then
    log_error "pi subprocess failed (exit $?); stderr follows:"
    cat "$pi_stderr" >> "$ERROR_LOG" 2>/dev/null || true
    rm -f "$pi_stderr"
    record_dangling_sha
    exit 1
  fi
  rm -f "$pi_stderr"
fi

# --- Step 2: commit distill's changes on the distill branch. ---------------
#
# The vault's `.gitignore` (installed by extensions/distill/auto-setup.ts)
# already excludes `.napkin/distill/`, so a plain `git add -A` will not
# sweep in our per-worktree session fork or meta.json. Worktrees
# themselves live OUTSIDE the vault (under `$XDG_CACHE_HOME/napkin-distill/`),
# so there are no sibling worktree paths to exclude.

git -C "$WORKTREE" add -A
# `git commit` exits non-zero if nothing is staged, which is legitimate: pi
# may have concluded there was nothing worth distilling. Detect and continue.
if git -C "$WORKTREE" diff --cached --quiet; then
  # Nothing to commit — distill was a no-op. Skip straight to cleanup.
  exit 0
fi

if ! git_retry git -C "$WORKTREE" commit -m "distill: auto-distill content" > /dev/null 2>&1; then
  log_error "git commit failed on distill branch"
  record_dangling_sha
  exit 1
fi

# --- Step 3: merge main into distill. LLM driver handles *.md conflicts. ---

# Merge may return non-zero when conflicts remain after the driver 3-strikes
# on some files; exit 1 is the expected "conflicts remain, salvage below".
# Any other non-zero exit code (128 for corrupt index, 129+ for option
# errors, etc.) indicates a REAL failure that salvage can't recover from
# — log forensic info and bail out.
#
# We deliberately do NOT wrap this in git_retry: retrying after a partial
# conflict leaves git with "you have unmerged files" and the second attempt
# returns 128 (false positive for our unexpected-failure branch).
# Transient index.lock contention on this single call isn't a real
# concern — we're the only writer on the distill branch.
merge_rc=0
git -C "$WORKTREE" merge --no-edit "$DEFAULT_BRANCH" > /dev/null 2>&1 || merge_rc=$?
# Testing hook: override the captured merge rc so tests can cover the
# unexpected-exit-code branch (128 etc.) without having to contrive a
# real git failure of that shape.
if [ -n "${NAPKIN_DISTILL_FORCE_MERGE_RC:-}" ]; then
  merge_rc="$NAPKIN_DISTILL_FORCE_MERGE_RC"
fi
case "$merge_rc" in
  0)
    # Clean merge — driver handled every conflict, no salvage needed.
    ;;
  1)
    # Conflicts remain after driver 3-strike. Proceed to salvage below.
    ;;
  *)
    log_error "git merge $DEFAULT_BRANCH failed unexpectedly (exit $merge_rc) — aborting"
    record_dangling_sha
    # Leave the merge in progress for forensic inspection; cleanup trap
    # will wipe the worktree. Do NOT attempt salvage — the failure mode
    # is unknown.
    exit 1
    ;;
esac

# Partial-merge salvage: any file still marked unmerged (driver gave up) gets
# reverted to main's version. This preserves the clean distill content while
# discarding files we couldn't resolve. Each discarded file is logged.
UNMERGED="$(git -C "$WORKTREE" diff --name-only --diff-filter=U 2>/dev/null || true)"
if [ -n "$UNMERGED" ]; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    log_error "partial-merge: reverted '$f' to $DEFAULT_BRANCH's version (LLM driver 3-strike)"
    git -C "$WORKTREE" checkout "$DEFAULT_BRANCH" -- "$f" > /dev/null 2>&1 || \
      log_error "  failed to checkout $DEFAULT_BRANCH:$f"
    git -C "$WORKTREE" add -- "$f" > /dev/null 2>&1 || true
  done <<< "$UNMERGED"
  # Complete the merge commit with whatever's now staged. --no-edit reuses
  # the merge message git prepared (even with conflicts it has one drafted).
  if ! git_retry git -C "$WORKTREE" commit --no-edit > /dev/null 2>&1; then
    log_error "failed to complete partial-merge commit"
    record_dangling_sha
    exit 1
  fi
fi

# Testing hook: force a MERGE_HEAD file to exist so the escape-hatch check
# below fires. Lets tests cover the path without relying on a race between
# git's merge logic and the driver's output (which real-world tests can't
# reliably stage — git clears MERGE_HEAD on driver exit 0).
if [ "${NAPKIN_DISTILL_FORCE_MERGE_HEAD:-}" = "1" ]; then
  _gitdir="$(git -C "$WORKTREE" rev-parse --git-dir 2>/dev/null || true)"
  if [ -n "$_gitdir" ]; then
    echo "deadbeefcafebabe" > "$_gitdir/MERGE_HEAD"
  fi
fi

# Re-check: if MERGE_HEAD is still present the merge never completed
# (e.g. driver wrote output that still contains markers). Bail — the caller's
# squash below would silently lose content.
if [ -f "$WORKTREE/.git/MERGE_HEAD" ] || \
   [ -f "$(git -C "$WORKTREE" rev-parse --git-dir)/MERGE_HEAD" ]; then
  log_error "merge did not complete (MERGE_HEAD still present)"
  record_dangling_sha
  exit 1
fi

# --- Step 4: squash distill into $DEFAULT_BRANCH from the main vault. ------

cd "$VAULT" || { log_error "cd vault failed"; exit 1; }

# Defensive: refuse to squash if the vault's HEAD isn't on the default branch.
# `git merge --squash <branch>` stages changes onto whatever is checked out;
# if the user has a feature branch in the main vault while auto-distill
# fires, the squash would corrupt that branch's history with distill commits.
# The spec's "Main history stays linear" invariant assumes HEAD == main.
VAULT_HEAD="$(git symbolic-ref --short HEAD 2>/dev/null || true)"
if [ -n "$VAULT_HEAD" ] && [ "$VAULT_HEAD" != "$DEFAULT_BRANCH" ]; then
  log_error "vault HEAD is '$VAULT_HEAD', expected '$DEFAULT_BRANCH' — refusing to squash-merge distill into the wrong branch"
  record_dangling_sha
  exit 1
fi

if ! git_retry git merge --squash "$BRANCH" > /dev/null 2>&1; then
  log_error "git merge --squash failed"
  record_dangling_sha
  exit 1
fi

# Squash may result in no staged changes (e.g. distill's changes were already
# in main — unlikely in practice but possible with concurrent distills that
# took the same content). Skip the commit if so.
if git diff --cached --quiet; then
  exit 0
fi

SQUASH_MSG="distill: merge ${BRANCH_SHORT}"
if ! git_retry git commit -m "$SQUASH_MSG" > /dev/null 2>&1; then
  log_error "git commit failed on main after squash"
  record_dangling_sha
  exit 1
fi

# Success — the trap cleans up on exit 0.
exit 0
