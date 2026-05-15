import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { spawnDistill } from "./index";

/**
 * Regression tests for the legacy `spawnDistill` code path (manual
 * `/distill` on git-less vaults, or as fallback when git-backed paths
 * decline). The older implementation built a shell command string and
 * `spawn("sh", ["-c", cmd])` — every interpolated variable was one
 * shell-escape mishap away from an injection. The current implementation
 * uses `bash -c <fixed template> _ <arg1> <arg2> ...` which keeps the
 * template literal and flows every tainted value through positional
 * argv ($1..$N). These tests pin the argv contract so regressions are
 * caught.
 */

function createSeededSessionFile(cwd: string, dir: string): string {
  const sm = SessionManager.create(cwd, dir);
  sm.appendMessage({ role: "user", content: "hello" });
  sm.appendMessage({ role: "assistant", content: "hi" });
  const file = sm.getSessionFile();
  if (!file || !fs.existsSync(file)) {
    throw new Error("failed to create test session on disk");
  }
  return file;
}

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
    emitter.pid = 23456;
    setImmediate(() => emitter.emit("exit", 0, null));
    return emitter;
  }) as unknown as typeof spawn;
  return { spawnFn, calls };
}

describe("spawnDistill (legacy argv-based path, SEC-1)", () => {
  let cwd: string;
  let sessionDir: string;
  let sessionFile: string;
  const tmpDirs: string[] = [];

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-legacy-cwd-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-legacy-src-"));
    sessionFile = createSeededSessionFile(cwd, sessionDir);
  });

  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  test("spawns `bash -c <template> _ <positional args>` (no interpolated command string)", () => {
    const { spawnFn, calls } = makeMockSpawn();
    const tmpDir = spawnDistill(
      sessionFile,
      cwd,
      {
        enabled: true,
        intervalMinutes: 60,
        onShutdown: true,
      },
      spawnFn,
    );
    expect(tmpDir).not.toBeNull();
    if (tmpDir) tmpDirs.push(tmpDir);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.command).toBe("bash");

    // args[0] must be literally "-c" — bash's standard invocation for an
    // inline script template.
    expect(call.args[0]).toBe("-c");

    // args[1] is the FIXED script template — never interpolated from
    // tainted input. Sanity-pin a few stable markers so template drift
    // is caught.
    expect(typeof call.args[1]).toBe("string");
    expect(call.args[1]).toContain("set -u");
    expect(call.args[1]).toContain('pi_args=(--session "$SESSION"');
    expect(call.args[1]).toContain('rm -rf -- "$TMPDIR_ARG"');

    // args[2] is the `$0` placeholder convention for `bash -c`.
    expect(call.args[2]).toBe("_");

    // args[3..7] carry the positional payload: piBin, session, tmpDir,
    // prompt, model.
    expect(call.args[3]).toBe("pi"); // default when NAPKIN_DISTILL_PI_BIN is unset
    expect(call.args[4].startsWith(tmpDir as string)).toBe(true);
    expect(call.args[5]).toBe(tmpDir as string);
    expect(typeof call.args[6]).toBe("string");
    expect(call.args[6].length).toBeGreaterThan(0);
    // Empty model string when model is omitted.
    expect(call.args[7]).toBe("");
  });

  test("forwards model as argv[7] without embedding in the template", () => {
    const { spawnFn, calls } = makeMockSpawn();
    const tmpDir = spawnDistill(
      sessionFile,
      cwd,
      {
        enabled: true,
        intervalMinutes: 60,
        onShutdown: true,
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      },
      spawnFn,
    );
    if (tmpDir) tmpDirs.push(tmpDir);

    expect(calls[0].args[7]).toBe("anthropic/claude-sonnet-4-5");
    // The template stays stable — model flows through $5, not the literal.
    expect(calls[0].args[1]).not.toContain("anthropic");
    expect(calls[0].args[1]).not.toContain("claude-sonnet-4-5");
  });

  test("prompt does NOT contain the worktree-isolation prefix (R7-CC-11)", () => {
    // POST-R6-CACHE prepends a worktree-isolation prefix to the
    // distill prompt only via `worktreeSpawnFn`'s `buildWorktreeDistillPrompt`.
    // The legacy spawn path (this one) is for git-less / disabled /
    // legacy-embedded vaults where there's no worktree to isolate —
    // the prefix would be a confusing lie. Pin that the prompt the
    // legacy path sends to the wrapper does NOT contain the prefix's
    // signature phrase, so a future refactor that accidentally folds
    // the prefix into a shared helper surfaces the regression here.
    const { spawnFn, calls } = makeMockSpawn();
    const tmpDir = spawnDistill(
      sessionFile,
      cwd,
      { enabled: true, intervalMinutes: 60, onShutdown: true },
      spawnFn,
    );
    if (tmpDir) tmpDirs.push(tmpDir);
    // args[6] is the LEGACY_DISTILL_PROMPT positional that the wrapper
    // passes to `pi -p`. Worktree-isolation prefix's signature phrase from
    // `buildWorktreeDistillPrompt` is "isolated git worktree at".
    expect(calls[0].args[6]).not.toContain("isolated git worktree at");
  });

  test("passes detached + stdio:ignore + NAPKIN_DISTILL_NO_RECURSE", () => {
    const { spawnFn, calls } = makeMockSpawn();
    const tmpDir = spawnDistill(
      sessionFile,
      cwd,
      {
        enabled: true,
        intervalMinutes: 60,
        onShutdown: true,
      },
      spawnFn,
    );
    if (tmpDir) tmpDirs.push(tmpDir);

    const opts = calls[0].options;
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe("ignore");
    expect(opts.cwd).toBe(cwd);
    expect(opts.env.NAPKIN_DISTILL_NO_RECURSE).toBe("1");
  });

  test("shell-metacharacter values stay isolated as argv — never concatenated into template", () => {
    // If model.id contained a shell metacharacter, the old sh -c path
    // would need correct shell-escaping to remain safe. The argv contract
    // treats every value as a raw string — no escaping needed, no
    // injection surface. Pin the contract.
    const { spawnFn, calls } = makeMockSpawn();
    const malicious = "claude'; rm -rf /";
    const tmpDir = spawnDistill(
      sessionFile,
      cwd,
      {
        enabled: true,
        intervalMinutes: 60,
        onShutdown: true,
        model: { provider: "anthropic", id: malicious },
      },
      spawnFn,
    );
    if (tmpDir) tmpDirs.push(tmpDir);

    // The raw metacharacter-laden value is ONE argv entry, isolated from
    // the others. Not substring-concatenated into the template.
    expect(calls[0].args[7]).toBe(`anthropic/${malicious}`);
    expect(calls[0].args[1]).not.toContain("rm -rf /");
    // No arg is a composite shell command string.
    for (const arg of calls[0].args) {
      expect(arg).not.toContain("sh -c");
    }
  });

  test("respects NAPKIN_DISTILL_PI_BIN override (test hook)", () => {
    const prev = process.env.NAPKIN_DISTILL_PI_BIN;
    process.env.NAPKIN_DISTILL_PI_BIN = "/fake/pi-bin";
    try {
      const { spawnFn, calls } = makeMockSpawn();
      const tmpDir = spawnDistill(
        sessionFile,
        cwd,
        {
          enabled: true,
          intervalMinutes: 60,
          onShutdown: true,
        },
        spawnFn,
      );
      if (tmpDir) tmpDirs.push(tmpDir);

      expect(calls[0].args[3]).toBe("/fake/pi-bin");
    } finally {
      if (prev === undefined) delete process.env.NAPKIN_DISTILL_PI_BIN;
      else process.env.NAPKIN_DISTILL_PI_BIN = prev;
    }
  });
});
