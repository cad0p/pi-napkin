/**
 * Per-distill workspace management.
 *
 * Each auto-distill invocation gets its own isolated workspace so concurrent
 * distills (interval, shutdown, or multiple pi sessions) don't race on vault
 * files. Phase B milestone 2 is the minimum layout; milestone 3 extends this
 * to use a real git worktree instead of a plain tmp dir.
 *
 * Layout produced here (tmp-dir flavor, pre-worktree):
 *   <workspace-root>/
 *     .napkin/
 *       distill/
 *         session.jsonl   # forked session, pi subprocess reads this
 *         meta.json       # DistillMeta, see below
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@mariozechner/pi-coding-agent";

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
 * Handle returned by `createDistillWorkspace`. All paths are absolute and live
 * inside the workspace root (which itself is either a tmp dir or a git
 * worktree rooted under `<vault>/.napkin/distill-worktrees/<branch>/`).
 */
export interface DistillWorkspace {
  /** Workspace root (the `cwd` for the distill subprocess). */
  worktreePath: string;
  /** Branch name chosen for this distill (unique per invocation). */
  branchName: string;
  /** Path to the forked session .jsonl inside the workspace. */
  sessionForkPath: string;
  /** Path to meta.json inside the workspace. */
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
 * Relative path (from workspace root) of the distill `.napkin/distill/` dir.
 * Exported so tests and milestone-3 worktree code can reference the same
 * constant without stringly-typed drift.
 */
export const DISTILL_SUBDIR = path.join(".napkin", "distill");

/**
 * Create a distill workspace.
 *
 * Milestone 2 (this function): workspace is a fresh tmp directory under
 * `os.tmpdir()/napkin-distill-<branch-suffix>/`. No git involvement yet.
 * Milestone 3 replaces the tmp-dir creation with `git worktree add` (see
 * `createDistillWorktree`) and routes callers through
 * `spawnDistillInWorktree`.
 *
 * @param vault              Absolute path to the main vault (NOT a worktree).
 *                           Stored in meta.json for traceability.
 * @param sourceSessionFile  Absolute path to the parent session .jsonl. Forked
 *                           via `SessionManager.forkFrom` into the workspace.
 * @returns handle with absolute paths; caller spawns pi with
 *          `cwd=worktreePath` and `--session sessionForkPath`.
 *
 * @throws if `sourceSessionFile` doesn't exist, isn't a valid session, or the
 *         fork itself fails. Partial tmp dirs are cleaned up on throw.
 */
export function createDistillWorkspace(
  vault: string,
  sourceSessionFile: string,
): DistillWorkspace {
  const branchName = generateDistillBranchName();
  // Use the branch suffix (everything after `distill/`) as the tmp-dir tag so
  // orphaned workspaces are traceable back to a branch name.
  const branchSuffix = branchName.slice("distill/".length);
  const worktreePath = fs.mkdtempSync(
    path.join(os.tmpdir(), `napkin-distill-${branchSuffix}-`),
  );

  try {
    const distillDir = path.join(worktreePath, DISTILL_SUBDIR);
    fs.mkdirSync(distillDir, { recursive: true });

    // SessionManager.forkFrom writes to <sessionDir>/<uuid>.jsonl. We want a
    // deterministic name (`session.jsonl`) so the wrapper script can reference
    // it without globbing, so we pass sessionDir and then rename the created
    // file afterwards.
    const forkedSm = SessionManager.forkFrom(
      sourceSessionFile,
      worktreePath,
      distillDir,
    );
    const forkedFile = forkedSm.getSessionFile();
    if (!forkedFile) {
      throw new Error("SessionManager.forkFrom did not produce a session file");
    }

    const sessionForkPath = path.join(distillDir, "session.jsonl");
    if (forkedFile !== sessionForkPath) {
      // Idempotent: if a previous run somehow left session.jsonl, we want the
      // fresh fork.
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
    // Best-effort cleanup; a leaked tmp dir is a minor annoyance, not a
    // correctness issue.
    fs.rmSync(worktreePath, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Remove a distill workspace. Idempotent: safe to call multiple times, safe
 * to call on a path that doesn't exist. Used in the `sh -c` wrapper's trap
 * and in test teardown.
 */
export function cleanupDistillWorkspace(worktreePath: string): void {
  fs.rmSync(worktreePath, { recursive: true, force: true });
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
