import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@mariozechner/pi-coding-agent";

import {
  cleanupDistillWorkspace,
  type DistillWorkspace,
  spawnDistillInWorktree,
} from "./distill-workspace";
import { DISTILL_WRAPPER_SCRIPT } from "./scripts-paths";

/**
 * Tests for `spawnDistillInWorktree` split into two groups:
 *   - unit: mock the `spawn` function, verify we pass the right args to the
 *     shell. Does not create a git repo or touch pi.
 *   - integration: real bash wrapper against a temp git repo. Stubs pi via
 *     `NAPKIN_DISTILL_SKIP_PI=1` and pre-stages changes manually so we can
 *     test the git lifecycle independently of any pi binary.
 *
 * The integration tests don't go through `spawnDistillInWorktree` directly
 * (the detached + stdio:ignore spawn makes exit-code assertions flaky).
 * Instead they invoke the wrapper via `spawnSync` so we get the exit code.
 */

/**
 * Minimal real session file to feed SessionManager.forkFrom. Identical helper
 * as in distill-workspace.test.ts — copied rather than shared because these
 * test fixtures tend to drift independently.
 */
function createSeededSessionFile(dir: string, cwd: string): string {
  const sm = SessionManager.create(cwd, dir);
  sm.appendMessage({ role: "user", content: "hello" });
  sm.appendMessage({ role: "assistant", content: "hi" });
  const file = sm.getSessionFile();
  if (!file || !fs.existsSync(file)) {
    throw new Error("failed to create test session on disk");
  }
  return file;
}

/** Initialize a throwaway git vault with one commit + `.napkin/` scaffold. */
function createGitVault(opts: { seedMd?: string } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "distill-spawn-vault-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const run = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, env, encoding: "utf-8" });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    }
  };
  run(["init", "-q", "-b", "main"]);
  run(["config", "commit.gpgsign", "false"]);
  run(["config", "user.name", "test"]);
  run(["config", "user.email", "test@example.com"]);
  // Seed a markdown file so merges have something to test with.
  fs.writeFileSync(
    path.join(dir, "seed.md"),
    opts.seedMd ?? "---\ntitle: seed\n---\n# seed\n",
  );
  // Pre-scaffold the merge-driver .gitattributes rule. Mirrors what Phase C
  // auto-init will do so `registerMergeDriver` becomes a no-op in tests — if
  // we didn't do this, the first distill would always commit a .gitattributes
  // change on top of any content changes, polluting test expectations and
  // causing cross-distill merge conflicts on .gitattributes.
  fs.writeFileSync(
    path.join(dir, ".gitattributes"),
    "*.md merge=napkin-distill-merge\n",
  );
  // Pre-scaffold the `.gitignore` rules that Phase C auto-setup writes at
  // session_start. Needed for the wrapper's `git add -A` step: without
  // these excludes, the distill's session fork (`.napkin/distill/*`) and
  // any sibling worktree scaffolding (`.napkin/distill-worktrees/*`) would
  // get staged into the distill commit.
  fs.writeFileSync(
    path.join(dir, ".gitignore"),
    ".napkin/distill/\n.napkin/distill-worktrees/\n",
  );
  // Napkin's configPath expects `.napkin/` to exist for the content vault
  // layout; create it upfront.
  fs.mkdirSync(path.join(dir, ".napkin"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".napkin", "config.json"), "{}");
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "seed"]);
  return dir;
}

// ---------------------------------------------------------------------------
// Unit tests — mock `spawn` to verify the wrapper invocation.
// ---------------------------------------------------------------------------

describe("spawnDistillInWorktree (unit, mocked spawn)", () => {
  let vault: string;
  let sessionDir: string;
  let sessionFile: string;
  const workspaces: Pick<DistillWorkspace, "worktreePath" | "branchName">[] =
    [];

  beforeEach(() => {
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-unit-src-"));
    sessionFile = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    for (const w of workspaces) cleanupDistillWorkspace(vault, w);
    workspaces.length = 0;
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  /**
   * Build a fake ChildProcess object that captures the spawn call for
   * assertions but doesn't actually start anything.
   */
  function makeMockSpawn(): {
    spawnFn: typeof spawn;
    calls: Array<{
      command: string;
      args: readonly string[];
      // biome-ignore lint/suspicious/noExplicitAny: options are opaque
      options: any;
    }>;
  } {
    const calls: Array<{
      command: string;
      args: readonly string[];
      // biome-ignore lint/suspicious/noExplicitAny: options are opaque
      options: any;
    }> = [];
    const spawnFn = ((
      command: string,
      args: readonly string[],
      // biome-ignore lint/suspicious/noExplicitAny: options are opaque
      options: any,
    ) => {
      calls.push({ command, args, options });
      const emitter = new EventEmitter() as EventEmitter & {
        unref: () => void;
        pid: number;
      };
      emitter.unref = () => {};
      emitter.pid = 12345;
      // Schedule a no-op exit so anyone who .on('exit') listens wouldn't hang.
      setImmediate(() => emitter.emit("exit", 0, null));
      return emitter;
    }) as unknown as typeof spawn;
    return { spawnFn, calls };
  }

  test("spawns `sh` with the wrapper script path and expected positional args", () => {
    const { spawnFn, calls } = makeMockSpawn();
    const result = spawnDistillInWorktree({
      vault,
      sessionFile,
      prompt: "test prompt",
      spawnFn,
    });
    workspaces.push(result.workspace);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.command).toBe("sh");

    // Args: [wrapper, vault, worktree, branch, sessionFork, prompt, errorDir, model, defaultBranch]
    expect(call.args[0]).toBe(DISTILL_WRAPPER_SCRIPT);
    expect(call.args[1]).toBe(vault);
    expect(call.args[2]).toBe(result.workspace.worktreePath);
    expect(call.args[3]).toBe(result.workspace.branchName);
    expect(call.args[4]).toBe(result.workspace.sessionForkPath);
    expect(call.args[5]).toBe("test prompt");
    // errorDir lives under Napkin's configPath — may be either `<vault>/.napkin`
    // (content layout) or `~/.napkin` (legacy). Just assert it ends with
    // `distill/errors`.
    expect(call.args[6].endsWith(path.join("distill", "errors"))).toBe(true);
    // Empty model string when model is omitted.
    expect(call.args[7]).toBe("");
    // Default branch resolved from the vault — createGitVault() uses
    // `git init -b main` so this should be `main`.
    expect(call.args[8]).toBe("main");
  });

  test("sets detached, stdio:ignore, and NAPKIN_DISTILL_NO_RECURSE", () => {
    const { spawnFn, calls } = makeMockSpawn();
    const result = spawnDistillInWorktree({
      vault,
      sessionFile,
      prompt: "p",
      spawnFn,
    });
    workspaces.push(result.workspace);

    const opts = calls[0].options;
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe("ignore");
    expect(opts.cwd).toBe(result.workspace.worktreePath);
    expect(opts.env.NAPKIN_DISTILL_NO_RECURSE).toBe("1");
  });

  test("passes model through when provided", () => {
    const { spawnFn, calls } = makeMockSpawn();
    const result = spawnDistillInWorktree({
      vault,
      sessionFile,
      prompt: "p",
      model: "anthropic/claude-sonnet-4-5",
      spawnFn,
    });
    workspaces.push(result.workspace);

    expect(calls[0].args[7]).toBe("anthropic/claude-sonnet-4-5");
  });

  test("ensures errorDir exists on disk before spawning", () => {
    const { spawnFn, calls } = makeMockSpawn();
    const result = spawnDistillInWorktree({
      vault,
      sessionFile,
      prompt: "p",
      spawnFn,
    });
    workspaces.push(result.workspace);

    const errorDir = calls[0].args[6];
    expect(fs.existsSync(errorDir)).toBe(true);
    expect(fs.statSync(errorDir).isDirectory()).toBe(true);
  });

  test("returns the workspace handle and spawn pid", () => {
    const { spawnFn } = makeMockSpawn();
    const result = spawnDistillInWorktree({
      vault,
      sessionFile,
      prompt: "p",
      spawnFn,
    });
    workspaces.push(result.workspace);

    expect(result.workspace.branchName).toMatch(/^distill\/[0-9a-f]{6}-\d+$/);
    expect(result.pid).toBe(12345);
    expect(fs.existsSync(result.workspace.worktreePath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — real bash wrapper, stubbed pi.
// ---------------------------------------------------------------------------

describe("distill-wrapper.sh (integration)", () => {
  let vault: string;
  let sessionDir: string;
  let sessionFile: string;

  beforeEach(() => {
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-integ-src-"));
    sessionFile = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  /**
   * Run the wrapper synchronously using the workspace handle. Returns
   * { exitCode, stderr }.
   *
   * We use `NAPKIN_DISTILL_SKIP_PI=1` to bypass the pi call; the caller
   * pre-stages any file changes they want to simulate.
   */
  function runWrapper(
    workspace: DistillWorkspace,
    extraEnv: Record<string, string> = {},
  ): { exitCode: number; stderr: string } {
    const errorDir = path.join(vault, ".napkin", "distill", "errors");
    fs.mkdirSync(errorDir, { recursive: true });
    const r = spawnSync(
      "sh",
      [
        DISTILL_WRAPPER_SCRIPT,
        vault,
        workspace.worktreePath,
        workspace.branchName,
        workspace.sessionForkPath,
        "test prompt",
        errorDir,
        "",
      ],
      {
        cwd: workspace.worktreePath,
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@example.com",
          NAPKIN_DISTILL_NO_RECURSE: "1",
          NAPKIN_DISTILL_SKIP_PI: "1",
          ...extraEnv,
        },
      },
    );
    return { exitCode: r.status ?? -1, stderr: r.stderr ?? "" };
  }

  /**
   * Create a workspace and stage a new markdown file in it so the wrapper's
   * `git add -A` has something to commit. Returns the workspace and the
   * absolute path to the staged file.
   */
  function createWorkspaceWithChanges(
    filename: string,
    content: string,
  ): { workspace: DistillWorkspace; stagedFile: string } {
    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace = createDistillWorkspace(vault, sessionFile);
    const stagedFile = path.join(workspace.worktreePath, filename);
    fs.writeFileSync(stagedFile, content);
    return { workspace, stagedFile };
  }

  test("happy path: commits distill changes and squash-merges to main", () => {
    const { workspace } = createWorkspaceWithChanges(
      "note.md",
      "---\ntitle: new\n---\n# new note\n",
    );
    const branch = workspace.branchName;

    const r = runWrapper(workspace);
    expect(r.exitCode).toBe(0);

    // Worktree and branch cleaned up.
    expect(fs.existsSync(workspace.worktreePath)).toBe(false);
    const branches = spawnSync("git", ["-C", vault, "branch"], {
      encoding: "utf-8",
    }).stdout;
    expect(branches).not.toContain(branch);

    // main has a new squash commit with our file.
    const log = spawnSync("git", ["-C", vault, "log", "--oneline", "-n", "5"], {
      encoding: "utf-8",
    }).stdout;
    expect(log).toContain("distill: merge");

    // The note.md should be on main now.
    const mainFile = path.join(vault, "note.md");
    expect(fs.existsSync(mainFile)).toBe(true);
    expect(fs.readFileSync(mainFile, "utf-8")).toContain("# new note");
  });

  test("empty distill (no changes): exits 0 and cleans up without creating a commit", () => {
    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace = createDistillWorkspace(vault, sessionFile);
    const branch = workspace.branchName;
    const logBefore = spawnSync("git", ["-C", vault, "log", "--oneline"], {
      encoding: "utf-8",
    }).stdout;

    const r = runWrapper(workspace);
    expect(r.exitCode).toBe(0);

    // Cleanup happened.
    expect(fs.existsSync(workspace.worktreePath)).toBe(false);
    const branches = spawnSync("git", ["-C", vault, "branch"], {
      encoding: "utf-8",
    }).stdout;
    expect(branches).not.toContain(branch);

    // No new commits on main.
    const logAfter = spawnSync("git", ["-C", vault, "log", "--oneline"], {
      encoding: "utf-8",
    }).stdout;
    expect(logAfter).toBe(logBefore);
  });

  test("concurrent worktrees don't interfere (both complete)", () => {
    // Two workspaces with disjoint content — both should land on main.
    const a = createWorkspaceWithChanges("a.md", "---\ntitle: a\n---\n# a\n");
    const b = createWorkspaceWithChanges("b.md", "---\ntitle: b\n---\n# b\n");

    const rA = runWrapper(a.workspace);
    expect(rA.exitCode).toBe(0);
    const rB = runWrapper(b.workspace);
    expect(rB.exitCode).toBe(0);

    expect(fs.existsSync(path.join(vault, "a.md"))).toBe(true);
    expect(fs.existsSync(path.join(vault, "b.md"))).toBe(true);
  });

  test("missing required arg: exits 2 without cleanup errors", () => {
    const r = spawnSync("sh", [DISTILL_WRAPPER_SCRIPT, "only-one-arg"], {
      encoding: "utf-8",
    });
    expect(r.status).toBe(2);
  });

  test("wrapper rewrites meta.json pid to its own pid (C2)", () => {
    // The parent JS side writes meta.json with `pid: process.pid` (the
    // parent pi session). The wrapper MUST overwrite that with its own
    // pid ($$) so liveness checks against the recorded pid track the
    // wrapper's lifetime, not the long-lived parent session's.
    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace: DistillWorkspace = createDistillWorkspace(
      vault,
      sessionFile,
    );
    const metaPath = path.join(
      workspace.worktreePath,
      ".napkin",
      "distill",
      "meta.json",
    );

    // Before wrapper runs: meta.pid = parent (this process).
    const beforeMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    expect(beforeMeta.pid).toBe(process.pid);

    // Run the wrapper with HALT_AFTER_META so it updates meta.json then
    // exits 0 without touching pi, git, or the cleanup trap. The worktree
    // survives so we can inspect meta.json.
    const errorDir = path.join(vault, ".napkin", "distill", "errors");
    fs.mkdirSync(errorDir, { recursive: true });
    const r = spawnSync(
      "sh",
      [
        DISTILL_WRAPPER_SCRIPT,
        vault,
        workspace.worktreePath,
        workspace.branchName,
        workspace.sessionForkPath,
        "test prompt",
        errorDir,
        "",
      ],
      {
        cwd: workspace.worktreePath,
        encoding: "utf-8",
        env: {
          ...process.env,
          NAPKIN_DISTILL_NO_RECURSE: "1",
          NAPKIN_DISTILL_HALT_AFTER_META: "1",
        },
      },
    );
    expect(r.status).toBe(0);

    // After wrapper runs: meta.pid should NOT be this process's pid.
    // (The wrapper's pid is distinct from the test's pid; spawnSync
    // exits the child before returning, so we can't compare to a live
    // pid — but we CAN confirm it's no longer the parent's.)
    const afterMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    expect(typeof afterMeta.pid).toBe("number");
    expect(afterMeta.pid).not.toBe(process.pid);
    expect(afterMeta.pid).toBeGreaterThan(0);

    // Other meta fields unchanged by the pid rewrite.
    expect(afterMeta.vault).toBe(beforeMeta.vault);
    expect(afterMeta.branch).toBe(beforeMeta.branch);
    expect(afterMeta.startedAt).toBe(beforeMeta.startedAt);
    expect(afterMeta.parentSession).toBe(beforeMeta.parentSession);

    // Clean up — HALT_AFTER_META skipped the trap so we must manually
    // tear down the worktree and branch.
    spawnSync(
      "git",
      ["-C", vault, "worktree", "remove", "--force", workspace.worktreePath],
      { encoding: "utf-8" },
    );
    spawnSync("git", ["-C", vault, "branch", "-D", workspace.branchName], {
      encoding: "utf-8",
    });
  });
});

// ---------------------------------------------------------------------------
// Partial-merge salvage tests. Forces a conflict between main and the distill
// branch, stubs the merge driver via NAPKIN_DISTILL_MERGE_MOCK=fail so the
// LLM path always 3-strikes, then verifies that:
//   - clean files keep the distill's content
//   - conflicted files revert to main's version
//   - error log is written with file path + reason
//   - main still receives a squash commit with the clean-file change
//
// Note: the wrapper self-heals .gitattributes via registerMergeDriver. The
// vault fixture pre-scaffolds the same line so config drift doesn't affect
// these assertions.
// ---------------------------------------------------------------------------

describe("distill-wrapper.sh (partial-merge salvage)", () => {
  let vault: string;
  let sessionDir: string;
  let sessionFile: string;

  beforeEach(() => {
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-salvage-src-"));
    sessionFile = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  /**
   * Run a git command in `dir`, throwing on non-zero exit. Used to build
   * conflict-inducing state on the vault's main branch before invoking the
   * wrapper.
   */
  function runGitOrThrow(dir: string, args: string[]): string {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const r = spawnSync("git", ["-C", dir, ...args], {
      env,
      encoding: "utf-8",
    });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    }
    return r.stdout;
  }

  /**
   * Run the wrapper with the merge driver mocked to always fail. Pre-stages
   * the given files in the worktree before invoking. Returns exit code +
   * error log contents (read post-run from the vault's error dir).
   */
  function runWrapperWithMockFail(
    workspace: DistillWorkspace,
    worktreeFiles: Record<string, string>,
  ): { exitCode: number; errorLogs: string[] } {
    for (const [relPath, content] of Object.entries(worktreeFiles)) {
      const abs = path.join(workspace.worktreePath, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    const errorDir = path.join(vault, ".napkin", "distill", "errors");
    fs.mkdirSync(errorDir, { recursive: true });
    const r = spawnSync(
      "sh",
      [
        DISTILL_WRAPPER_SCRIPT,
        vault,
        workspace.worktreePath,
        workspace.branchName,
        workspace.sessionForkPath,
        "test prompt",
        errorDir,
        "",
      ],
      {
        cwd: workspace.worktreePath,
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@example.com",
          NAPKIN_DISTILL_NO_RECURSE: "1",
          NAPKIN_DISTILL_SKIP_PI: "1",
          NAPKIN_DISTILL_MERGE_MOCK: "fail",
          // Speed up tests: no retry backoff.
          NAPKIN_GIT_RETRY_MAX: "2",
          NAPKIN_GIT_RETRY_DELAY: "0",
        },
      },
    );
    const errorLogs: string[] = [];
    if (fs.existsSync(errorDir)) {
      for (const f of fs.readdirSync(errorDir)) {
        errorLogs.push(fs.readFileSync(path.join(errorDir, f), "utf-8"));
      }
    }
    return { exitCode: r.status ?? -1, errorLogs };
  }

  test("clean file keeps distill's content, conflicted file reverts to main", () => {
    // Baseline: main already has `conflict.md` and `clean.md` from the seed
    // commit. Mutate `conflict.md` on main so the distill's version
    // conflicts; leave `clean.md` untouched on main.
    const conflictPath = path.join(vault, "conflict.md");
    const cleanPath = path.join(vault, "clean.md");
    fs.writeFileSync(
      conflictPath,
      "---\ntitle: conflict\n---\n# initial content\n",
    );
    fs.writeFileSync(
      cleanPath,
      "---\ntitle: clean\n---\n# initial clean content\n",
    );
    runGitOrThrow(vault, ["add", "-A"]);
    runGitOrThrow(vault, ["commit", "-q", "-m", "add baseline files"]);

    // Create workspace AFTER the baseline commit so the worktree sees both
    // files. Then mutate main's copy of conflict.md to force a divergence.
    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace: DistillWorkspace = createDistillWorkspace(
      vault,
      sessionFile,
    );

    fs.writeFileSync(
      conflictPath,
      "---\ntitle: conflict\n---\n# MAIN's version after baseline\n",
    );
    runGitOrThrow(vault, ["add", "conflict.md"]);
    runGitOrThrow(vault, ["commit", "-q", "-m", "main mutates conflict.md"]);

    // Stage distill-branch changes in the worktree:
    //   - conflict.md: different content → merge conflict
    //   - clean.md:    modified, no conflict on main → clean merge
    const r = runWrapperWithMockFail(workspace, {
      "conflict.md":
        "---\ntitle: conflict\n---\n# DISTILL's different version\n",
      "clean.md": "---\ntitle: clean\n---\n# distill updated the clean file\n",
    });

    expect(r.exitCode).toBe(0);

    // Worktree + branch cleaned up.
    expect(fs.existsSync(workspace.worktreePath)).toBe(false);
    const branches = runGitOrThrow(vault, ["branch"]);
    expect(branches).not.toContain(workspace.branchName);

    // conflict.md on main = MAIN's version (salvage reverted distill's).
    const conflictAfter = fs.readFileSync(conflictPath, "utf-8");
    expect(conflictAfter).toContain("MAIN's version after baseline");
    expect(conflictAfter).not.toContain("DISTILL's different version");

    // clean.md on main = distill's version (merged cleanly).
    const cleanAfter = fs.readFileSync(cleanPath, "utf-8");
    expect(cleanAfter).toContain("distill updated the clean file");

    // Error log written with the conflicted file path + reason.
    expect(r.errorLogs.length).toBeGreaterThan(0);
    const combined = r.errorLogs.join("\n");
    expect(combined).toContain("conflict.md");
    expect(combined).toContain("partial-merge");

    // Main has a squash commit.
    const log = runGitOrThrow(vault, ["log", "--oneline", "-n", "5"]);
    expect(log).toContain("distill: merge");
  });

  test("all files conflict: salvage reverts everything, no squash commit created", () => {
    // Both distill's files collide with main, AND there are no clean files
    // — the squash merge produces nothing new, so main should NOT get a
    // distill commit. This verifies the empty-squash guard survives the
    // salvage path.
    const a = path.join(vault, "a.md");
    fs.writeFileSync(a, "---\ntitle: a\n---\n# baseline\n");
    runGitOrThrow(vault, ["add", "a.md"]);
    runGitOrThrow(vault, ["commit", "-q", "-m", "add a"]);

    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace: DistillWorkspace = createDistillWorkspace(
      vault,
      sessionFile,
    );

    fs.writeFileSync(a, "---\ntitle: a\n---\n# MAIN's later version\n");
    runGitOrThrow(vault, ["add", "a.md"]);
    runGitOrThrow(vault, ["commit", "-q", "-m", "main mutates a"]);

    const logBefore = runGitOrThrow(vault, ["log", "--oneline"]);

    const r = runWrapperWithMockFail(workspace, {
      "a.md": "---\ntitle: a\n---\n# DISTILL's different version\n",
    });
    expect(r.exitCode).toBe(0);

    // Cleanup happened.
    expect(fs.existsSync(workspace.worktreePath)).toBe(false);

    // Main unchanged: no new squash commit because all content was salvaged
    // back to main's version.
    const logAfter = runGitOrThrow(vault, ["log", "--oneline"]);
    expect(logAfter).toBe(logBefore);

    // Error log records the salvage.
    expect(r.errorLogs.length).toBeGreaterThan(0);
    expect(r.errorLogs.join("\n")).toContain("a.md");
  });
});

// ---------------------------------------------------------------------------
// MERGE_HEAD escape-hatch. The wrapper's last-line defense (after salvage)
// covers the case where the driver returned exit 0 but its output still
// contained conflict markers — git then sees MERGE_HEAD still present and
// the merge is incomplete. The wrapper bails and writes to error log.
// Previously dead code in CI (no mock mode emitted conflict markers).
// Covers coverage-review G4.
// ---------------------------------------------------------------------------

describe("distill-wrapper.sh (MERGE_HEAD escape-hatch)", () => {
  let vault: string;
  let sessionDir: string;
  let sessionFile: string;

  beforeEach(() => {
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-mh-src-"));
    sessionFile = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  function runGitOrThrow(dir: string, args: string[]): string {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const r = spawnSync("git", ["-C", dir, ...args], {
      env,
      encoding: "utf-8",
    });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    }
    return r.stdout;
  }

  test("MERGE_HEAD persists after merge: wrapper bails + logs", () => {
    // Real-world triggering (driver writes conflict-markers and git still
    // marks merge incomplete) requires a specific git internals state
    // that CI can't reliably stage: driver exit 0 clears MERGE_HEAD. Use
    // the NAPKIN_DISTILL_FORCE_MERGE_HEAD=1 testing hook so the wrapper
    // creates MERGE_HEAD immediately before its escape-hatch check.
    //
    // Pre-stage a simple change so the wrapper runs past the no-op early
    // exit.
    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace: DistillWorkspace = createDistillWorkspace(
      vault,
      sessionFile,
    );
    fs.writeFileSync(
      path.join(workspace.worktreePath, "new.md"),
      "---\ntitle: new\n---\n# content\n",
    );

    const errorDir = path.join(vault, ".napkin", "distill", "errors");
    fs.mkdirSync(errorDir, { recursive: true });
    const r = spawnSync(
      "sh",
      [
        DISTILL_WRAPPER_SCRIPT,
        vault,
        workspace.worktreePath,
        workspace.branchName,
        workspace.sessionForkPath,
        "test prompt",
        errorDir,
        "",
      ],
      {
        cwd: workspace.worktreePath,
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@example.com",
          NAPKIN_DISTILL_NO_RECURSE: "1",
          NAPKIN_DISTILL_SKIP_PI: "1",
          NAPKIN_DISTILL_FORCE_MERGE_HEAD: "1",
          NAPKIN_GIT_RETRY_MAX: "2",
          NAPKIN_GIT_RETRY_DELAY: "0",
        },
      },
    );

    // Wrapper exits 1 because the escape-hatch fires.
    expect(r.status).toBe(1);

    // Error log contains the MERGE_HEAD diagnostic.
    const errorLogs = fs.existsSync(errorDir)
      ? fs
          .readdirSync(errorDir)
          .map((f) => fs.readFileSync(path.join(errorDir, f), "utf-8"))
      : [];
    expect(errorLogs.length).toBeGreaterThan(0);
    expect(errorLogs.join("\n")).toContain("MERGE_HEAD still present");

    // Dangling SHA recorded for forensic recovery.
    expect(errorLogs.join("\n")).toContain("dangling distill commit SHA:");

    // No distill squash commit on main — the content was never merged.
    const log = runGitOrThrow(vault, ["log", "--oneline", "-n", "10"]);
    expect(log).not.toContain("distill: merge");
  });
});

// ---------------------------------------------------------------------------
// End-to-end LLM-resolved conflict tests. Forces a real conflict between main
// and the distill branch, uses NAPKIN_DISTILL_MERGE_MOCK=ok so the driver
// emits a plausible merge (ours+theirs concatenated), then verifies that the
// resolved content SURVIVES the squash-merge to main.
//
// Covers the core concurrency story end-to-end: `.gitattributes` routes to
// the driver, the driver fires during `git merge main` in the wrapper, and
// the driver's output reaches main. Previous salvage tests only force
// `fail`; these pin the happy path.
// ---------------------------------------------------------------------------

describe("distill-wrapper.sh (LLM-resolved conflict, end-to-end)", () => {
  let vault: string;
  let sessionDir: string;
  let sessionFile: string;

  beforeEach(() => {
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-e2e-src-"));
    sessionFile = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  function runGitOrThrow(dir: string, args: string[]): string {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const r = spawnSync("git", ["-C", dir, ...args], {
      env,
      encoding: "utf-8",
    });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    }
    return r.stdout;
  }

  /**
   * Invoke the wrapper against a pre-populated worktree with the `ok`
   * merge-driver mock enabled, so the LLM driver "resolves" conflicts by
   * concatenating ours+theirs. Returns the wrapper exit code + any error-log
   * contents (expected empty on the happy path).
   */
  function runWrapperWithMockOk(
    workspace: DistillWorkspace,
    worktreeFiles: Record<string, string>,
    mockOverride?: string,
  ): { exitCode: number; errorLogs: string[] } {
    for (const [relPath, content] of Object.entries(worktreeFiles)) {
      const abs = path.join(workspace.worktreePath, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    const errorDir = path.join(vault, ".napkin", "distill", "errors");
    fs.mkdirSync(errorDir, { recursive: true });
    const r = spawnSync(
      "sh",
      [
        DISTILL_WRAPPER_SCRIPT,
        vault,
        workspace.worktreePath,
        workspace.branchName,
        workspace.sessionForkPath,
        "test prompt",
        errorDir,
        "",
      ],
      {
        cwd: workspace.worktreePath,
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@example.com",
          NAPKIN_DISTILL_NO_RECURSE: "1",
          NAPKIN_DISTILL_SKIP_PI: "1",
          NAPKIN_DISTILL_MERGE_MOCK: mockOverride ?? "ok",
          NAPKIN_GIT_RETRY_MAX: "2",
          NAPKIN_GIT_RETRY_DELAY: "0",
        },
      },
    );
    const errorLogs: string[] = [];
    if (fs.existsSync(errorDir)) {
      for (const f of fs.readdirSync(errorDir)) {
        errorLogs.push(fs.readFileSync(path.join(errorDir, f), "utf-8"));
      }
    }
    return { exitCode: r.status ?? -1, errorLogs };
  }

  test("LLM-resolved conflict: driver output lands on main", () => {
    // Baseline: a file that both sides will diverge on.
    const conflictPath = path.join(vault, "shared.md");
    fs.writeFileSync(
      conflictPath,
      "---\ntitle: shared\n---\n# baseline shared content\n",
    );
    runGitOrThrow(vault, ["add", "-A"]);
    runGitOrThrow(vault, ["commit", "-q", "-m", "add shared"]);

    // Create the worktree at this baseline, then mutate main post-hoc so
    // the divergence is real (same pattern as the salvage tests).
    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace: DistillWorkspace = createDistillWorkspace(
      vault,
      sessionFile,
    );

    fs.writeFileSync(
      conflictPath,
      "---\ntitle: shared\n---\n# MAIN's later addition\n",
    );
    runGitOrThrow(vault, ["add", "shared.md"]);
    runGitOrThrow(vault, ["commit", "-q", "-m", "main mutates shared"]);

    // The distill branch writes its own divergent version. With the `ok`
    // mock the driver emits ours+theirs concatenated.
    const r = runWrapperWithMockOk(workspace, {
      "shared.md":
        "---\ntitle: shared\n---\n# DISTILL's addition (not the same)\n",
    });
    expect(r.exitCode).toBe(0);
    // No error log on the happy path.
    expect(r.errorLogs).toEqual([]);

    // Worktree + branch cleaned up.
    expect(fs.existsSync(workspace.worktreePath)).toBe(false);
    const branches = runGitOrThrow(vault, ["branch"]);
    expect(branches).not.toContain(workspace.branchName);

    // Resolved content on main contains BOTH sides' markers (driver=ok
    // concatenates). Proves: (1) driver fired during git merge in the
    // worktree, (2) the resolved content survived the squash-merge to main.
    const finalContent = fs.readFileSync(conflictPath, "utf-8");
    expect(finalContent).toContain("MAIN's later addition");
    expect(finalContent).toContain("DISTILL's addition (not the same)");

    // Main has a squash commit.
    const log = runGitOrThrow(vault, ["log", "--oneline", "-n", "5"]);
    expect(log).toContain("distill: merge");
  });

  test("driver retries: ok-after-2 succeeds on the third attempt", () => {
    // Verifies the 3-strike retry loop bridges transient failures. The
    // first two attempts fail (exit 1) and the third succeeds — the
    // resolved content must still land on main.
    const conflictPath = path.join(vault, "retry.md");
    fs.writeFileSync(conflictPath, "---\ntitle: retry\n---\n# baseline\n");
    runGitOrThrow(vault, ["add", "-A"]);
    runGitOrThrow(vault, ["commit", "-q", "-m", "add retry"]);

    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace: DistillWorkspace = createDistillWorkspace(
      vault,
      sessionFile,
    );

    fs.writeFileSync(
      conflictPath,
      "---\ntitle: retry\n---\n# MAIN post-baseline\n",
    );
    runGitOrThrow(vault, ["add", "retry.md"]);
    runGitOrThrow(vault, ["commit", "-q", "-m", "main mutates retry"]);

    const r = runWrapperWithMockOk(
      workspace,
      {
        "retry.md":
          "---\ntitle: retry\n---\n# DISTILL post-baseline (diverges)\n",
      },
      "ok-after-2",
    );
    expect(r.exitCode).toBe(0);
    expect(r.errorLogs).toEqual([]);

    const finalContent = fs.readFileSync(conflictPath, "utf-8");
    expect(finalContent).toContain("MAIN post-baseline");
    expect(finalContent).toContain("DISTILL post-baseline (diverges)");

    const log = runGitOrThrow(vault, ["log", "--oneline", "-n", "5"]);
    expect(log).toContain("distill: merge");
  });
});

// ---------------------------------------------------------------------------
// Default-branch detection + respect. Hardcoding `main` silently corrupts
// vaults that use `master` (older git, users with init.defaultBranch=master
// in global config). Verify the wrapper works end-to-end on a `master`-
// default vault.
// ---------------------------------------------------------------------------

describe("distill-wrapper.sh (non-main default branch)", () => {
  let vault: string;
  let sessionDir: string;
  let sessionFile: string;

  function createMasterDefaultVault(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "distill-master-vault-"));
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const run = (args: string[]) => {
      const r = spawnSync("git", args, { cwd: dir, env, encoding: "utf-8" });
      if (r.status !== 0) {
        throw new Error(
          `git ${args.join(" ")} failed: ${r.stderr || r.stdout}`,
        );
      }
    };
    run(["init", "-q", "-b", "master"]);
    run(["config", "commit.gpgsign", "false"]);
    run(["config", "user.name", "test"]);
    run(["config", "user.email", "test@example.com"]);
    fs.writeFileSync(path.join(dir, "seed.md"), "# seed\n");
    fs.writeFileSync(
      path.join(dir, ".gitattributes"),
      "*.md merge=napkin-distill-merge\n",
    );
    fs.writeFileSync(
      path.join(dir, ".gitignore"),
      ".napkin/distill/\n.napkin/distill-worktrees/\n",
    );
    fs.mkdirSync(path.join(dir, ".napkin"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".napkin", "config.json"), "{}");
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "seed"]);
    return dir;
  }

  beforeEach(() => {
    vault = createMasterDefaultVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-master-src-"));
    sessionFile = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test("detectDefaultBranch returns 'master' for a master-default vault", () => {
    const { detectDefaultBranch } = require("./distill-workspace");
    expect(detectDefaultBranch(vault)).toBe("master");
  });

  test("wrapper squash-merges into master when default branch is master", () => {
    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace: DistillWorkspace = createDistillWorkspace(
      vault,
      sessionFile,
    );
    const stagedFile = path.join(workspace.worktreePath, "new-note.md");
    fs.writeFileSync(stagedFile, "---\ntitle: new\n---\n# new note\n");

    const errorDir = path.join(vault, ".napkin", "distill", "errors");
    fs.mkdirSync(errorDir, { recursive: true });
    const r = spawnSync(
      "sh",
      [
        DISTILL_WRAPPER_SCRIPT,
        vault,
        workspace.worktreePath,
        workspace.branchName,
        workspace.sessionForkPath,
        "test prompt",
        errorDir,
        "",
        "master", // 8th arg: default branch
      ],
      {
        cwd: workspace.worktreePath,
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@example.com",
          NAPKIN_DISTILL_NO_RECURSE: "1",
          NAPKIN_DISTILL_SKIP_PI: "1",
          NAPKIN_GIT_RETRY_MAX: "2",
          NAPKIN_GIT_RETRY_DELAY: "0",
        },
      },
    );
    expect(r.status).toBe(0);

    // No error log entries.
    const errorLogs = fs.existsSync(errorDir)
      ? fs
          .readdirSync(errorDir)
          .map((f) => fs.readFileSync(path.join(errorDir, f), "utf-8"))
      : [];
    expect(errorLogs).toEqual([]);

    // master has the squash commit.
    const log = spawnSync(
      "git",
      ["-C", vault, "log", "--oneline", "master", "-n", "5"],
      { encoding: "utf-8" },
    ).stdout;
    expect(log).toContain("distill: merge");

    // The new note lands on master.
    expect(fs.existsSync(path.join(vault, "new-note.md"))).toBe(true);
  });
});
