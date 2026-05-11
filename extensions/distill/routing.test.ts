import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@mariozechner/pi-coding-agent";

import distillExtension from "./index";

/**
 * Tests that verify Item 7 routing:
 *   - the interval timer set up by `session_start` calls `runAutoDistill`,
 *     which creates a git worktree under `.napkin/distill-worktrees/`
 *   - the `/distill` command handler calls the legacy `runDistill`, which
 *     creates a tmp directory under `os.tmpdir()` (not a worktree)
 *
 * We don't mock the `spawn` function itself \u2014 the wrapper scripts are
 * detached and clean up after themselves when pi isn't in PATH. The test
 * synchronously observes the workspace artifacts (worktree vs tmp dir)
 * created BEFORE spawn returns, so we don't race with the wrapper's trap.
 *
 * `setInterval` is stubbed so we can capture the interval callback set up
 * by `session_start` and invoke it deterministically instead of waiting.
 */

/** Minimal spy-style ExtensionAPI that captures handlers and commands. */
interface CapturedExtensionAPI {
  // biome-ignore lint/suspicious/noExplicitAny: opaque event handlers by name
  handlers: Record<string, (event: any, ctx: any) => Promise<void> | void>;
  commands: Record<
    string,
    // biome-ignore lint/suspicious/noExplicitAny: opaque command handlers
    { handler: (args: string, ctx: any) => Promise<void> | void }
  >;
}

/**
 * Build a mock ExtensionAPI that captures `on(event, h)` and
 * `registerCommand(name, opts)` calls. Other methods are no-ops since the
 * extension doesn't use them during session_start / command invocation.
 */
function makeMockExtensionAPI(): {
  api: unknown;
  captured: CapturedExtensionAPI;
} {
  const captured: CapturedExtensionAPI = { handlers: {}, commands: {} };
  const api = {
    // biome-ignore lint/suspicious/noExplicitAny: match ExtensionAPI shape loosely
    on(event: string, handler: any) {
      captured.handlers[event] = handler;
    },
    // biome-ignore lint/suspicious/noExplicitAny: match ExtensionAPI shape loosely
    registerCommand(name: string, opts: any) {
      captured.commands[name] = opts;
    },
    registerTool() {},
    registerShortcut() {},
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
    setSessionName() {},
    getSessionName() {
      return undefined;
    },
    setLabel() {},
    async exec() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    getActiveTools() {
      return [];
    },
    getAllTools() {
      return [];
    },
    setActiveTools() {},
  };
  return { api, captured };
}

/** Git vault fixture with distill.enabled=true. */
function createEnabledGitVault(intervalMinutes: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-vault-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "t@e",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "t@e",
  };
  const git = (args: string[]) =>
    spawnSync("git", ["-C", dir, ...args], { env, encoding: "utf-8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["config", "user.name", "t"]);
  git(["config", "user.email", "t@e"]);
  fs.writeFileSync(
    path.join(dir, "seed.md"),
    "---\ntitle: seed\n---\n# seed\n",
  );
  fs.writeFileSync(
    path.join(dir, ".gitattributes"),
    "*.md merge=napkin-distill-merge\n",
  );
  fs.mkdirSync(path.join(dir, ".napkin"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".napkin", "config.json"),
    JSON.stringify({
      distill: { enabled: true, intervalMinutes, onShutdown: true },
    }),
  );
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed"]);
  return dir;
}

/** Seed a real SessionManager at `dir` (needed because runAutoDistill forks it). */
function createSeededSession(dir: string): SessionManager {
  const sm = SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "hello" });
  sm.appendMessage({ role: "assistant", content: "hi" });
  return sm;
}

describe("runAutoDistill vs runDistill routing (Item 7)", () => {
  let vault: string;
  let sm: SessionManager;
  let capturedInterval: (() => void) | null = null;
  let originalSetInterval: typeof setInterval;
  const _savedRecurse = process.env.NAPKIN_DISTILL_NO_RECURSE;

  beforeEach(() => {
    delete process.env.NAPKIN_DISTILL_NO_RECURSE;
    vault = createEnabledGitVault(60);
    sm = createSeededSession(vault);

    // Stub `setInterval` to capture the interval callback set by
    // session_start. We route the countdown tick (1s) straight through so
    // it doesn't clutter the capture \u2014 only grab the first interval (which
    // is the distill timer at intervalMinutes*60000 ms). Restore in afterEach.
    originalSetInterval = globalThis.setInterval;
    capturedInterval = null;
    globalThis.setInterval = ((
      cb: () => void,
      ms: number,
      ...rest: unknown[]
    ) => {
      // Distill interval is intervalMinutes * 60_000 = 3,600,000 at minutes=60.
      // Countdown is 1000. Poll is 2000. Capture the first handle > 60_000
      // so we don't catch the status-bar ticker.
      if (ms > 10_000 && capturedInterval === null) {
        capturedInterval = cb;
        // Return a fake handle that clearInterval(null) won't choke on.
        return { unref: () => {}, ref: () => {} } as unknown as NodeJS.Timeout;
      }
      return originalSetInterval(cb, ms, ...rest);
    }) as typeof setInterval;
  });

  afterEach(() => {
    if (_savedRecurse !== undefined)
      process.env.NAPKIN_DISTILL_NO_RECURSE = _savedRecurse;
    else delete process.env.NAPKIN_DISTILL_NO_RECURSE;
    globalThis.setInterval = originalSetInterval;
    // Best-effort cleanup of any dangling worktrees + branches the detached
    // wrapper may have left during the test window.
    const worktreesDir = path.join(vault, ".napkin", "distill-worktrees");
    if (fs.existsSync(worktreesDir)) {
      for (const entry of fs.readdirSync(worktreesDir)) {
        const wt = path.join(worktreesDir, entry);
        spawnSync("git", ["-C", vault, "worktree", "remove", "--force", wt], {
          encoding: "utf-8",
        });
      }
    }
    spawnSync("git", ["-C", vault, "worktree", "prune"], { encoding: "utf-8" });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  /**
   * Build a minimal ExtensionContext-shaped object. session_start reads
   * sessionManager.getBranch + getSessionFile; interval callback uses
   * sessionManager.getSessionFile + cwd + ui.
   */
  // biome-ignore lint/suspicious/noExplicitAny: partial ExtensionContext
  function makeCtx(): any {
    return {
      cwd: vault,
      sessionManager: sm,
      hasUI: false,
      ui: null,
    };
  }

  test("interval callback creates a worktree (runAutoDistill path)", async () => {
    const { api, captured } = makeMockExtensionAPI();
    distillExtension(api as never);
    expect(captured.handlers.session_start).toBeDefined();

    const ctx = makeCtx();
    await captured.handlers.session_start({ reason: "new" }, ctx);
    expect(capturedInterval).not.toBeNull();

    const worktreesDir = path.join(vault, ".napkin", "distill-worktrees");
    expect(
      fs.existsSync(worktreesDir) ? fs.readdirSync(worktreesDir).length : 0,
    ).toBe(0);

    // Invoke the interval callback \u2014 this is what the real setInterval would
    // call on tick. If wiring is correct, it routes to runAutoDistill and
    // creates a worktree synchronously (before detached spawn returns).
    capturedInterval?.();

    // Worktree created under .napkin/distill-worktrees/. The directory name
    // is the branch suffix (hex-epoch) from createDistillWorkspace.
    expect(fs.existsSync(worktreesDir)).toBe(true);
    const entries = fs.readdirSync(worktreesDir);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatch(/^[0-9a-f]{6}-\d+$/);
  });

  test("/distill command creates a tmp dir, NOT a worktree (runDistill path)", async () => {
    const { api, captured } = makeMockExtensionAPI();
    distillExtension(api as never);
    expect(captured.commands.distill).toBeDefined();

    // Snapshot /tmp so we can detect new napkin-distill-* dirs created by
    // the legacy path.
    const tmpBefore = new Set(
      fs
        .readdirSync(os.tmpdir())
        .filter((n) => n.startsWith("napkin-distill-")),
    );

    const ctx = makeCtx();
    await captured.commands.distill.handler("", ctx);

    const tmpAfter = fs
      .readdirSync(os.tmpdir())
      .filter((n) => n.startsWith("napkin-distill-"));
    const newTmpDirs = tmpAfter.filter((n) => !tmpBefore.has(n));
    expect(newTmpDirs.length).toBe(1);

    // No worktree under the vault \u2014 the legacy path doesn't touch git.
    const worktreesDir = path.join(vault, ".napkin", "distill-worktrees");
    expect(fs.existsSync(worktreesDir)).toBe(false);

    // Cleanup: the detached wrapper's `rm -rf <tmpDir>` may not have run yet
    // (depends on how fast the shell can exec `pi`). Force-remove so we don't
    // leak across tests.
    for (const d of newTmpDirs) {
      fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
    }
  });
});
