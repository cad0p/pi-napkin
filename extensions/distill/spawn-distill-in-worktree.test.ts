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

    // Args: [wrapper, vault, worktree, branch, sessionFork, prompt, errorDir, model]
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
});
