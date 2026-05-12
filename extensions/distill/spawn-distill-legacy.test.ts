import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@mariozechner/pi-coding-agent";

import { spawnDistill } from "./index";
import { DISTILL_WRAPPER_LEGACY_SCRIPT } from "./scripts-paths";

/**
 * Regression tests for the legacy `spawnDistill` code path (manual
 * `/distill`, git-optional). The previous implementation built a shell
 * command string and `spawn("sh", ["-c", cmd])` — every variable
 * interpolated into that string was a single shell-escape mishap away from
 * an injection. These tests pin the new argv-based contract so regressions
 * are caught.
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

  test("spawns `sh` with the legacy wrapper path and positional argv (no sh -c)", () => {
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
    expect(call.command).toBe("sh");

    // The first arg is the wrapper script path — NOT "-c". This is the key
    // regression assertion: the old path passed "-c" + command string.
    expect(call.args[0]).toBe(DISTILL_WRAPPER_LEGACY_SCRIPT);
    expect(call.args[0]).not.toBe("-c");

    // Positional args: [script, sessionFile, tmpDir, prompt, model]
    // (the forked session path lives inside tmpDir).
    expect(call.args[1].startsWith(tmpDir as string)).toBe(true);
    expect(call.args[2]).toBe(tmpDir as string);
    expect(typeof call.args[3]).toBe("string");
    expect(call.args[3].length).toBeGreaterThan(0);
    // Empty model string when model is omitted.
    expect(call.args[4]).toBe("");
  });

  test("forwards model as argv[4] without embedding in a shell string", () => {
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

    expect(calls[0].args[4]).toBe("anthropic/claude-sonnet-4-5");
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

  test("shell-metacharacter values stay isolated as argv — never concatenated", () => {
    // If model.id contained a shell metacharacter, the old sh -c path would
    // need correct shell-escaping to remain safe. The new argv path treats
    // every value as a raw string — no escaping needed, no injection
    // surface. Pin the contract.
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
    // the others. Not substring-concatenated into a command string.
    expect(calls[0].args[4]).toBe(`anthropic/${malicious}`);
    // No arg is a composite shell command string.
    for (const arg of calls[0].args) {
      expect(arg).not.toContain("sh -c");
    }
  });
});
