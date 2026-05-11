/**
 * Per-distill workspace management.
 *
 * Each auto-distill invocation gets its own isolated git worktree so
 * concurrent distills (interval, shutdown, or multiple pi sessions) don't
 * race on vault files. Napkin resolves the vault from cwd, so a subprocess
 * launched with cwd = worktree operates on the worktree's copy of the vault.
 *
 * Layout per worktree:
 *   <worktree-root>/
 *     .napkin/
 *       distill/
 *         session.jsonl   # forked session, pi subprocess reads this
 *         meta.json       # DistillMeta, see below
 *
 * Lifecycle:
 *   createDistillWorkspace(vault, sessionFile)
 *     \u2192 createDistillWorktree(vault, branch, path)     (git worktree add -b ...)
 *     \u2192 SessionManager.forkFrom \u2192 session.jsonl
 *     \u2192 write meta.json
 *   ... distill subprocess runs in worktree ...
 *   removeDistillWorktree(vault, worktreePath, branch)
 *     \u2192 git worktree remove --force <path>
 *     \u2192 git branch -D <branch>
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { Napkin } from "@cad0p/napkin";
import { SessionManager } from "@mariozechner/pi-coding-agent";

import { DISTILL_WRAPPER_SCRIPT, MERGE_DRIVER_SCRIPT } from "./scripts-paths";

/**
 * Error class thrown by distill-workspace operations. Separate class so
 * callers can distinguish workspace-layer failures (worktree / git / fs)
 * from generic Errors raised by the stdlib.
 */
export class DistillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DistillError";
  }
}

/**
 * Metadata written to each distill workspace's `meta.json`. Consumed by the
 * Phase C `/distill-status` command and the forensic error-log path: if a
 * distill crashes, the on-disk meta plus the dangling branch SHA let us
 * recover the work or at least explain it.
 *
 * Schema is append-only. Readers MUST tolerate unknown fields.
 */
export interface DistillMeta {
  /** PID of the detached `sh -c` wrapper spawned by spawnDistillInWorktree. */
  pid: number;
  /** Absolute path to the main vault (NOT the worktree). */
  vault: string;
  /** Git branch name created for this distill, e.g. `distill/a1b2c3-1715198400`. */
  branch: string;
  /** ISO-8601 timestamp when the workspace was created. */
  startedAt: string;
  /** Absolute path to the parent session's .jsonl (for traceability). */
  parentSession: string;
}

/**
 * Handle returned by `createDistillWorkspace`. All paths are absolute and
 * live inside the worktree root.
 */
export interface DistillWorkspace {
  /** Worktree root (the `cwd` for the distill subprocess). */
  worktreePath: string;
  /** Branch name created for this distill (unique per invocation). */
  branchName: string;
  /** Path to the forked session .jsonl inside the worktree. */
  sessionForkPath: string;
  /** Path to meta.json inside the worktree. */
  metaPath: string;
}

/**
 * Generate a unique branch name per distill invocation. Format:
 *   distill/<6-hex-nonce>-<epoch-seconds>
 *
 * Nonce prevents collisions when two distills fire in the same second (unlikely
 * but cheap to prevent; relying on timestamp alone is a latent race).
 */
export function generateDistillBranchName(
  now: Date = new Date(),
  nonceHex?: string,
): string {
  const nonce = nonceHex ?? randomBytes(3).toString("hex");
  const epoch = Math.floor(now.getTime() / 1000);
  return `distill/${nonce}-${epoch}`;
}

/**
 * Relative path (from worktree root) of the distill `.napkin/distill/` dir.
 */
export const DISTILL_SUBDIR = path.join(".napkin", "distill");

/**
 * Root directory where all distill worktrees live, relative to the vault.
 * Gitignored by the Phase C auto-init scaffolding; worktrees should never be
 * committed back to the vault.
 */
export const DISTILL_WORKTREES_SUBDIR = path.join(
  ".napkin",
  "distill-worktrees",
);

/**
 * Throws `DistillError` if `vaultPath` is not a git repository. Phase B
 * requires auto-distill to run in a git context; Phase C's auto-init wires
 * session_start so this throw should never fire in practice for
 * distill.enabled vaults.
 */
function assertVaultIsGitRepo(vaultPath: string): void {
  const gitDir = path.join(vaultPath, ".git");
  if (!fs.existsSync(gitDir)) {
    throw new DistillError(
      `vault not a git repo: ${vaultPath} (auto-distill requires git; Phase C wires auto-init)`,
    );
  }
}

/**
 * Invoke `git` inside a specific cwd. Returns `{status, stdout, stderr}`.
 * Does not throw on non-zero exit \u2014 callers decide how to react (retry,
 * translate to DistillError, ignore, \u2026). 30s timeout per call is a sanity
 * ceiling; normal git invocations complete in milliseconds.
 */
function runGit(
  cwd: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/**
 * Ensure the worktree's local git config has the napkin-distill-merge
 * driver registered, and that `.gitattributes` routes `*.md` through it.
 *
 * Registration is per-worktree (`--local`, stays in the worktree's git config
 * dir, never propagates to the main repo or gets committed). The
 * `.gitattributes` line is per-file though \u2014 if the vault doesn't already
 * have one routing `*.md` through the driver, we append one. The appended
 * line gets committed along with the distill's content changes, which is
 * fine: committing the merge-driver rule to the vault is what lets the
 * driver actually fire during the merge back to main.
 *
 * Phase C's auto-init will pre-scaffold `.gitattributes` so this append
 * becomes a no-op; until then, we self-heal.
 */
function registerMergeDriver(worktreePath: string): void {
  // Register the driver in local git config. Local config lives in the
  // worktree's `.git` file (actually in the main repo's .git/config, since
  // worktrees share config by default \u2014 the config applies during all git
  // operations from this worktree's perspective).
  const nameRes = runGit(worktreePath, [
    "config",
    "--local",
    "merge.napkin-distill-merge.name",
    "napkin distill LLM merge driver",
  ]);
  if (nameRes.status !== 0) {
    throw new DistillError(
      `failed to configure merge driver name: ${nameRes.stderr.trim()}`,
    );
  }
  const driverRes = runGit(worktreePath, [
    "config",
    "--local",
    "merge.napkin-distill-merge.driver",
    `${MERGE_DRIVER_SCRIPT} %O %A %B %P`,
  ]);
  if (driverRes.status !== 0) {
    throw new DistillError(
      `failed to configure merge driver command: ${driverRes.stderr.trim()}`,
    );
  }

  // Ensure `*.md merge=napkin-distill-merge` is in .gitattributes. This is
  // the bit git consults during `git merge` to pick the driver. If
  // .gitattributes is missing or the line isn't present, append it.
  const attrsPath = path.join(worktreePath, ".gitattributes");
  const attrLine = "*.md merge=napkin-distill-merge";
  let existing = "";
  if (fs.existsSync(attrsPath)) {
    existing = fs.readFileSync(attrsPath, "utf-8");
  }
  if (!existing.split("\n").some((line) => line.trim() === attrLine)) {
    const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(attrsPath, `${existing}${sep}${attrLine}\n`);
  }
}

/**
 * Create a git worktree at `worktreePath` checked out to a fresh branch
 * `branchName` rooted at the vault's HEAD. Registers the napkin-distill-merge
 * driver in the worktree's local git config so subsequent `git merge`
 * invocations can resolve conflicts via the LLM.
 *
 * Precondition: vault is a git repo with at least one commit (HEAD
 * resolvable). Phase C's auto-init ensures both.
 *
 * @throws DistillError if:
 *   - vault has no `.git/` directory
 *   - `git worktree add` exits non-zero (branch collision, dirty state, ...)
 *   - merge driver registration fails
 *
 * @returns absolute worktree path on success (same as input, for chaining).
 */
export function createDistillWorktree(
  vaultPath: string,
  branchName: string,
  worktreePath: string,
): string {
  assertVaultIsGitRepo(vaultPath);
  // Ensure the parent of worktreePath exists; `git worktree add` requires a
  // non-existent target directory but will happily create intermediate dirs
  // for us \u2014 except when we're writing into `.napkin/distill-worktrees/`
  // which only exists after first use.
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  const res = runGit(vaultPath, [
    "worktree",
    "add",
    "-b",
    branchName,
    worktreePath,
    "HEAD",
  ]);
  if (res.status !== 0) {
    throw new DistillError(
      `git worktree add failed (exit ${res.status}): ${res.stderr.trim() || res.stdout.trim()}`,
    );
  }

  try {
    registerMergeDriver(worktreePath);
  } catch (err) {
    // Roll back the worktree if driver registration fails \u2014 an unregistered
    // worktree would merge with plain conflict markers instead of going
    // through the LLM, defeating the point.
    try {
      runGit(vaultPath, ["worktree", "remove", "--force", worktreePath]);
      runGit(vaultPath, ["branch", "-D", branchName]);
    } catch {
      // ignore
    }
    throw err;
  }

  return worktreePath;
}

/**
 * Remove a distill worktree and delete its branch. Idempotent \u2014 logs and
 * swallows errors because cleanup runs in shutdown / trap contexts where
 * throwing would mask more interesting failures upstream.
 *
 * Order matters: remove the worktree first (which releases the branch), then
 * delete the branch. Calling `git branch -D` while a worktree still holds
 * the branch fails.
 */
export function removeDistillWorktree(
  vaultPath: string,
  worktreePath: string,
  branchName: string,
): void {
  // Guard: vault may have been deleted between spawn and cleanup. Don't
  // throw \u2014 treat as "nothing to clean up".
  if (!fs.existsSync(path.join(vaultPath, ".git"))) return;

  const rmRes = runGit(vaultPath, [
    "worktree",
    "remove",
    "--force",
    worktreePath,
  ]);
  // If worktree removal fails, try to prune stale entries and continue on to
  // branch deletion; leaving a dangling branch is worse than a stale worktree.
  if (rmRes.status !== 0) {
    runGit(vaultPath, ["worktree", "prune"]);
  }

  // -D (force) in case the branch has unmerged content (expected: the squash
  // merge to main doesn't mark it as merged).
  runGit(vaultPath, ["branch", "-D", branchName]);
}

/**
 * Create a distill workspace = a fresh git worktree + session fork + meta.
 *
 * Workflow:
 *   1. Pick a unique branch name (`distill/<hex>-<epoch>`).
 *   2. Compute worktree path: `<vault>/.napkin/distill-worktrees/<branch-suffix>/`.
 *   3. `git worktree add -b <branch> <path> HEAD`.
 *   4. Make `<wt>/.napkin/distill/`, fork the source session into it, write
 *      meta.json.
 *   5. Return handle.
 *
 * On failure at any step after the worktree exists, the worktree + branch are
 * torn down via `removeDistillWorktree` so we never leak on throw.
 *
 * @param vault              Absolute path to the main vault (NOT a worktree).
 * @param sourceSessionFile  Absolute path to the parent session .jsonl.
 *
 * @throws DistillError if vault isn't a git repo, worktree creation fails,
 *         or session fork fails.
 */
export function createDistillWorkspace(
  vault: string,
  sourceSessionFile: string,
): DistillWorkspace {
  assertVaultIsGitRepo(vault);

  const branchName = generateDistillBranchName();
  const branchSuffix = branchName.slice("distill/".length);
  const worktreePath = path.join(vault, DISTILL_WORKTREES_SUBDIR, branchSuffix);

  createDistillWorktree(vault, branchName, worktreePath);

  try {
    const distillDir = path.join(worktreePath, DISTILL_SUBDIR);
    fs.mkdirSync(distillDir, { recursive: true });

    // SessionManager.forkFrom writes to <sessionDir>/<uuid>.jsonl. We want a
    // deterministic name (`session.jsonl`) so the wrapper script can reference
    // it without globbing.
    const forkedSm = SessionManager.forkFrom(
      sourceSessionFile,
      worktreePath,
      distillDir,
    );
    const forkedFile = forkedSm.getSessionFile();
    if (!forkedFile) {
      throw new DistillError(
        "SessionManager.forkFrom did not produce a session file",
      );
    }

    const sessionForkPath = path.join(distillDir, "session.jsonl");
    if (forkedFile !== sessionForkPath) {
      if (fs.existsSync(sessionForkPath)) {
        fs.rmSync(sessionForkPath, { force: true });
      }
      fs.renameSync(forkedFile, sessionForkPath);
    }

    const metaPath = path.join(distillDir, "meta.json");
    const meta: DistillMeta = {
      pid: process.pid,
      vault,
      branch: branchName,
      startedAt: new Date().toISOString(),
      parentSession: sourceSessionFile,
    };
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

    return { worktreePath, branchName, sessionForkPath, metaPath };
  } catch (err) {
    // Roll back worktree + branch so we never leak on failure. The cleanup is
    // itself best-effort; if it fails, the original error is what the caller
    // cares about.
    try {
      removeDistillWorktree(vault, worktreePath, branchName);
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * Remove a distill workspace. Idempotent: safe to call on partial state and
 * on a path that doesn't exist. Used by the `sh -c` wrapper's trap.
 *
 * Handles both the worktree + branch AND any leftover files inside the
 * worktree path (e.g., if the worktree was partially torn down by git but the
 * directory lingers).
 */
export function cleanupDistillWorkspace(
  vault: string,
  workspace: Pick<DistillWorkspace, "worktreePath" | "branchName">,
): void {
  removeDistillWorktree(vault, workspace.worktreePath, workspace.branchName);
  // Best-effort remove any leftover directory (git worktree remove normally
  // deletes it, but if the worktree was corrupted it may still exist).
  if (fs.existsSync(workspace.worktreePath)) {
    fs.rmSync(workspace.worktreePath, { recursive: true, force: true });
  }
}

/**
 * Parse `git worktree list --porcelain` output into a list of
 * `{ path, branch }` pairs. Only returns entries that have a branch (skips
 * detached-HEAD worktrees — we never create those for distills).
 *
 * Porcelain format is newline-separated records, each record is a block of
 * `key value` lines terminated by a blank line. We care about `worktree`
 * (absolute path) and `branch` (full ref, e.g. `refs/heads/distill/abc-1`).
 */
export function parseWorktreeList(
  porcelain: string,
): Array<{ path: string; branch: string }> {
  const out: Array<{ path: string; branch: string }> = [];
  let wt: string | null = null;
  let branch: string | null = null;
  const flush = () => {
    if (wt && branch) out.push({ path: wt, branch });
    wt = null;
    branch = null;
  };
  for (const line of porcelain.split("\n")) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) wt = line.slice("worktree ".length);
    else if (line.startsWith("branch "))
      branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
  }
  flush();
  return out;
}

/**
 * Liveness check: returns true if `pid` refers to a running process this
 * user can see. Uses signal 0 (no-op) — throws ESRCH when the pid is dead,
 * EPERM when it exists but is owned by another user (still "alive" from our
 * perspective — don't clean up someone else's worktree).
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // EPERM = exists but not signalable. Treat as alive (don't clobber).
    return e.code === "EPERM";
  }
}

/**
 * Number of minutes past which a worktree with a stale mtime on its
 * meta.json is considered abandoned — even if meta.json is still present.
 *
 * Covers `MAX_DISTILL_DURATION_MS` (10 minutes, defined in the extension
 * factory) with a 6× margin, so a worktree older than this either crashed
 * silently, lost its pid (e.g. kernel reboot), or somehow outlived its
 * shutdown timeout. The window is deliberately generous: a false-positive
 * here would clobber a slow-but-live distill, whereas waiting an extra
 * 50 minutes to sweep a dead one is harmless.
 */
export const STALE_WORKTREE_MINUTES = 60;

/**
 * Same threshold expressed in milliseconds for the mtime comparison site.
 * Kept as a separate export because existing callers (and tests) already
 * import `STALE_META_AGE_MS` directly.
 */
export const STALE_META_AGE_MS = STALE_WORKTREE_MINUTES * 60 * 1000;

/**
 * VaultInfo-shaped handle this module accepts. We rely only on `contentPath`
 * (the vault root = the git main worktree root) — kept minimal so tests and
 * callers don't have to construct a full Napkin instance.
 */
export interface StaleCleanupVault {
  contentPath: string;
}

/**
 * Remove distill worktrees that belong to dead sessions. Intended to run
 * once per `session_start` so long-lived vaults don't accumulate debris
 * from crashed pi instances.
 *
 * A worktree (branch matches `^distill/.*`) is removed if ANY of:
 *   1. `<wt>/.napkin/distill/meta.json` is missing
 *   2. meta.json's `pid` is not a running process
 *   3. meta.json's mtime is older than STALE_META_AGE_MS
 *
 * Removal is best-effort: failures on one worktree don't abort the sweep.
 *
 * @returns number of worktrees removed.
 */
export function cleanupStaleWorktrees(vault: StaleCleanupVault): number {
  const vaultPath = vault.contentPath;
  // No git in the vault → nothing to clean up. session_start may call us
  // before auto-init runs on first launch.
  if (!fs.existsSync(path.join(vaultPath, ".git"))) return 0;

  const listRes = runGit(vaultPath, ["worktree", "list", "--porcelain"]);
  if (listRes.status !== 0) return 0;

  const entries = parseWorktreeList(listRes.stdout).filter((e) =>
    e.branch.startsWith("distill/"),
  );

  let removed = 0;
  for (const entry of entries) {
    try {
      const metaPath = path.join(entry.path, DISTILL_SUBDIR, "meta.json");
      let shouldRemove = false;

      if (!fs.existsSync(metaPath)) {
        shouldRemove = true;
      } else {
        let mtime = 0;
        try {
          mtime = fs.statSync(metaPath).mtimeMs;
        } catch {
          shouldRemove = true;
        }
        if (!shouldRemove) {
          const meta = readDistillMeta(entry.path);
          if (!meta) {
            shouldRemove = true;
          } else if (!isPidAlive(meta.pid)) {
            shouldRemove = true;
          } else if (Date.now() - mtime > STALE_META_AGE_MS) {
            shouldRemove = true;
          }
        }
      }

      if (shouldRemove) {
        removeDistillWorktree(vaultPath, entry.path, entry.branch);
        removed += 1;
      }
    } catch {
      // Per-worktree failure is non-fatal; keep sweeping.
    }
  }

  return removed;
}

/**
 * Read a workspace's meta.json. Returns null if the file doesn't exist or
 * can't be parsed \u2014 callers treat this as "workspace is gone or stale".
 *
 * Never throws on missing files; throws only on unexpected I/O errors
 * (permissions, disk failure) that indicate a deeper problem.
 */
export function readDistillMeta(worktreePath: string): DistillMeta | null {
  const metaPath = path.join(worktreePath, DISTILL_SUBDIR, "meta.json");
  if (!fs.existsSync(metaPath)) return null;
  try {
    const raw = fs.readFileSync(metaPath, "utf-8");
    const parsed = JSON.parse(raw) as DistillMeta;
    // Light schema check: these fields are required by all consumers.
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.vault !== "string" ||
      typeof parsed.branch !== "string" ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.parentSession !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Result of `spawnDistillInWorktree` — returned for bookkeeping and tests.
 * The caller typically stores nothing beyond `workspace.branchName` so
 * `/distill-status` can later discover active workspaces by scanning
 * `.napkin/distill-worktrees/` and reading their `meta.json`.
 */
export interface SpawnDistillResult {
  workspace: DistillWorkspace;
  /** PID of the detached wrapper. The parent process MUST NOT wait on it. */
  pid: number;
}

/**
 * Arguments to `spawnDistillInWorktree`. Separated as an interface so callers
 * don't have to remember positional arg order — and so tests can supply the
 * `spawn` override without pulling in the full function signature.
 */
export interface SpawnDistillOptions {
  /** Absolute path to the main vault (NOT a worktree). */
  vault: string;
  /** Absolute path to the current session .jsonl to fork from. */
  sessionFile: string;
  /** Prompt passed to `pi -p`. */
  prompt: string;
  /** Optional model override, `<provider>/<id>`. Undefined → pi's default. */
  model?: string;
  /**
   * Override for the `spawn` function — wired by unit tests to capture calls
   * without actually starting processes. Defaults to the node:child_process
   * export at module load time.
   */
  spawnFn?: typeof spawn;
}

/**
 * Spawn a detached wrapper that performs the full auto-distill lifecycle
 * (pi → commit → merge → squash → cleanup) inside a per-distill worktree.
 *
 * Parent returns synchronously after the child is `unref`'d; the wrapper
 * survives parent exit (this is critical for shutdown distill — the parent
 * pi session is exiting, and the wrapper keeps running). All error paths
 * write to `<vault>/.napkin/distill/errors/` and do NOT block the parent.
 *
 * @throws DistillError if the workspace can't be created (git not a repo,
 *         branch collision, fork failure, …). Errors at this layer are
 *         unrecoverable by the caller beyond logging — no child to clean up
 *         (workspace creation rolled back on throw).
 */
export function spawnDistillInWorktree(
  opts: SpawnDistillOptions,
): SpawnDistillResult {
  const { vault, sessionFile, prompt, model } = opts;
  const spawnFn = opts.spawnFn ?? spawn;

  const workspace = createDistillWorkspace(vault, sessionFile);

  // Error dir lives on the MAIN vault (not in the worktree — worktrees are
  // removed on cleanup, which would lose the logs). Resolve via Napkin's
  // configPath so legacy (~/.napkin) and new (<content>/.napkin) layouts
  // both work.
  let errorDir: string;
  try {
    errorDir = path.join(
      new Napkin(vault).vault.configPath,
      "distill",
      "errors",
    );
  } catch {
    // Fallback: write under the vault itself. Shouldn't happen since the
    // vault resolved successfully upstream, but defensive — better than
    // throwing out of a spawn call.
    errorDir = path.join(vault, ".napkin", "distill", "errors");
  }
  fs.mkdirSync(errorDir, { recursive: true });

  const wrapperArgs = [
    DISTILL_WRAPPER_SCRIPT,
    vault,
    workspace.worktreePath,
    workspace.branchName,
    workspace.sessionForkPath,
    prompt,
    errorDir,
    model ?? "",
  ];

  // Detached spawn: stdio "ignore" + unref() so the parent can exit cleanly
  // while the wrapper continues. cwd is the worktree so if the wrapper itself
  // crashes before `cd`, any core-dumps etc. land inside the disposable area.
  const proc = spawnFn("sh", wrapperArgs, {
    cwd: workspace.worktreePath,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      NAPKIN_DISTILL_NO_RECURSE: "1",
    },
  });
  proc.unref();

  return {
    workspace,
    pid: proc.pid ?? -1,
  };
}
