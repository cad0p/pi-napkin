import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@mariozechner/pi-coding-agent";

import distillExtension from "./index";

/**
 * Tests for the session_shutdown handler (Phase B Item 8). Verifies that
 * the handler spawns an auto-distill worktree iff `shouldDistillOnShutdown`
 * returns true, and never blocks shutdown regardless of inner failures.
 *
 * Approach: observe the filesystem for `.napkin/distill-worktrees/<suffix>/`
 * directories as a proxy for "spawnDistillInWorktree was invoked". The
 * workspace is created synchronously by `spawnDistillInWorktree` before the
 * detached process exec, so we can assert immediately after the handler
 * returns without racing the wrapper's cleanup trap.
 *
 * `shouldDistillOnShutdown` itself has direct unit-test coverage in
 * should-distill-on-shutdown.test.ts \u2014 these tests cover the WIRING (the
 * handler assembles the right inputs and reacts to the predicate).
 */

/** Capture pi.on/registerCommand handlers; same shape as routing.test.ts. */
interface CapturedAPI {
  // biome-ignore lint/suspicious/noExplicitAny: opaque handlers
  handlers: Record<string, (event: any, ctx: any) => Promise<void> | void>;
  commands: Record<
    string,
    // biome-ignore lint/suspicious/noExplicitAny: opaque handlers
    { handler: (args: string, ctx: any) => Promise<void> | void }
  >;
}

function makeMockAPI(): { api: unknown; captured: CapturedAPI } {
  const captured: CapturedAPI = { handlers: {}, commands: {} };
  const api = {
    // biome-ignore lint/suspicious/noExplicitAny: loose pi shape
    on(event: string, handler: any) {
      captured.handlers[event] = handler;
    },
    // biome-ignore lint/suspicious/noExplicitAny: loose pi shape
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

/**
 * Build a git vault with distill config. Pass `withGit=false` to skip git
 * init \u2014 exercises the "needs git" guard in the shutdown handler.
 */
function createVault(
  config: {
    enabled: boolean;
    onShutdown?: boolean;
    intervalMinutes?: number;
  },
  withGit = true,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shutdown-vault-"));
  if (withGit) {
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
    fs.writeFileSync(path.join(dir, "seed.md"), "# seed\n");
    fs.writeFileSync(
      path.join(dir, ".gitattributes"),
      "*.md merge=napkin-distill-merge\n",
    );
    fs.mkdirSync(path.join(dir, ".napkin"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".napkin", "config.json"),
      JSON.stringify({
        distill: {
          enabled: config.enabled,
          onShutdown: config.onShutdown ?? true,
          intervalMinutes: config.intervalMinutes ?? 60,
        },
      }),
    );
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "seed"]);
  } else {
    fs.mkdirSync(path.join(dir, ".napkin"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".napkin", "config.json"),
      JSON.stringify({
        distill: {
          enabled: config.enabled,
          onShutdown: config.onShutdown ?? true,
          intervalMinutes: config.intervalMinutes ?? 60,
        },
      }),
    );
  }
  return dir;
}

/**
 * Create a SessionManager seeded with enough content that `getSessionFile()`
 * returns a path with `size > 0`. Returns the manager so the caller can
 * pass it as `ctx.sessionManager`.
 */
function createSession(dir: string): SessionManager {
  const sm = SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "hello" });
  sm.appendMessage({ role: "assistant", content: "hi" });
  return sm;
}

/** Count worktrees present under `<vault>/.napkin/distill-worktrees/`. */
function countWorktrees(vault: string): number {
  const d = path.join(vault, ".napkin", "distill-worktrees");
  if (!fs.existsSync(d)) return 0;
  return fs.readdirSync(d).length;
}

/** Best-effort cleanup of any dangling distill worktrees in `vault`. */
function cleanupWorktrees(vault: string): void {
  const d = path.join(vault, ".napkin", "distill-worktrees");
  if (!fs.existsSync(d)) return;
  for (const entry of fs.readdirSync(d)) {
    const wt = path.join(d, entry);
    spawnSync("git", ["-C", vault, "worktree", "remove", "--force", wt], {
      encoding: "utf-8",
    });
  }
  spawnSync("git", ["-C", vault, "worktree", "prune"], { encoding: "utf-8" });
}

describe("session_shutdown handler (Item 8)", () => {
  let vault: string;
  let sm: SessionManager;
  let originalSetInterval: typeof setInterval;

  // Clear the recursion-guard env var — test runner may be inside a distill subprocess.
  const _savedRecurse = process.env.NAPKIN_DISTILL_NO_RECURSE;
  beforeEach(() => {
    delete process.env.NAPKIN_DISTILL_NO_RECURSE;
    // Stub setInterval so session_start doesn't leak a real timer; shutdown
    // tests don't need the interval to fire.
    originalSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((
      _cb: () => void,
      _ms: number,
      ..._rest: unknown[]
    ) =>
      ({
        unref: () => {},
        ref: () => {},
      }) as unknown as NodeJS.Timeout) as typeof setInterval;
  });

  afterEach(() => {
    if (_savedRecurse !== undefined)
      process.env.NAPKIN_DISTILL_NO_RECURSE = _savedRecurse;
    else delete process.env.NAPKIN_DISTILL_NO_RECURSE;
    globalThis.setInterval = originalSetInterval;
    if (vault) {
      cleanupWorktrees(vault);
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });

  /**
   * Drive the full lifecycle: register extension, call session_start, then
   * session_shutdown with the given reason. Returns the count of worktrees
   * observed after shutdown returned.
   */
  async function runLifecycle(
    vaultPath: string,
    sessionManager: SessionManager,
    shutdownReason: "exit" | "reload" | "switch" | "error",
  ): Promise<number> {
    const { api, captured } = makeMockAPI();
    distillExtension(api as never);
    // biome-ignore lint/suspicious/noExplicitAny: partial ctx
    const ctx: any = {
      cwd: vaultPath,
      sessionManager,
      hasUI: false,
      ui: null,
    };
    await captured.handlers.session_start({ reason: "new" }, ctx);
    await captured.handlers.session_shutdown({ reason: shutdownReason }, ctx);
    return countWorktrees(vaultPath);
  }

  test("spawns on normal exit with enabled config + git vault + content", async () => {
    vault = createVault({ enabled: true });
    sm = createSession(vault);
    const worktrees = await runLifecycle(vault, sm, "exit");
    expect(worktrees).toBe(1);
  });

  test("does NOT spawn when shutdown reason is 'reload'", async () => {
    vault = createVault({ enabled: true });
    sm = createSession(vault);
    const worktrees = await runLifecycle(vault, sm, "reload");
    expect(worktrees).toBe(0);
  });

  test("does NOT spawn when config.onShutdown=false", async () => {
    vault = createVault({ enabled: true, onShutdown: false });
    sm = createSession(vault);
    const worktrees = await runLifecycle(vault, sm, "exit");
    expect(worktrees).toBe(0);
  });

  test("does NOT spawn when config.enabled=false", async () => {
    vault = createVault({ enabled: false });
    sm = createSession(vault);
    const worktrees = await runLifecycle(vault, sm, "exit");
    expect(worktrees).toBe(0);
  });

  test("does NOT spawn when session file is empty", async () => {
    vault = createVault({ enabled: true });
    // Create SessionManager without appending any messages \u2014 the file may
    // not even be flushed to disk yet. Either way, currentSize === 0 trips
    // shouldDistillOnShutdown's guard #7.
    sm = SessionManager.create(vault, vault);
    const worktrees = await runLifecycle(vault, sm, "exit");
    expect(worktrees).toBe(0);
  });

  test("auto-inits git at session_start when vault is not yet a repo (Phase C1)", async () => {
    // With Phase C1's auto-setup, a vault without `.git` gets initialized
    // during session_start, and the shutdown handler then spawns normally.
    // This replaces the Phase B "needs-git guard" test whose guard is
    // effectively dead in the happy path now — `ctx.cwd` is always a git
    // repo by the time session_shutdown runs.
    vault = createVault({ enabled: true }, /* withGit */ false);
    sm = createSession(vault);
    const worktrees = await runLifecycle(vault, sm, "exit");
    // Auto-init ran, so .git exists by shutdown, so the shutdown handler
    // does spawn a worktree.
    expect(fs.existsSync(path.join(vault, ".git"))).toBe(true);
    expect(worktrees).toBe(1);
  });

  test("does NOT spawn when NAPKIN_DISTILL_NO_RECURSE is set (recursion guard)", async () => {
    vault = createVault({ enabled: true });
    sm = createSession(vault);
    const before = process.env.NAPKIN_DISTILL_NO_RECURSE;
    process.env.NAPKIN_DISTILL_NO_RECURSE = "1";
    try {
      const worktrees = await runLifecycle(vault, sm, "exit");
      expect(worktrees).toBe(0);
    } finally {
      if (before === undefined) delete process.env.NAPKIN_DISTILL_NO_RECURSE;
      else process.env.NAPKIN_DISTILL_NO_RECURSE = before;
    }
  });

  test("shutdown never blocks when vault resolution fails", async () => {
    // Point ctx.cwd at a directory that Napkin can't resolve to a vault.
    // The handler's outer try/catch must swallow the error and still\u00a0complete.
    const bogusCwd = fs.mkdtempSync(path.join(os.tmpdir(), "no-vault-"));
    try {
      const { api, captured } = makeMockAPI();
      distillExtension(api as never);
      // biome-ignore lint/suspicious/noExplicitAny: partial ctx
      const ctx: any = {
        cwd: bogusCwd,
        sessionManager: SessionManager.create(bogusCwd, bogusCwd),
        hasUI: false,
        ui: null,
      };
      await captured.handlers.session_start({ reason: "new" }, ctx);
      // If this throws, the test fails \u2014 shutdown must be defensive.
      await expect(
        captured.handlers.session_shutdown({ reason: "exit" }, ctx),
      ).resolves.toBeUndefined();
    } finally {
      fs.rmSync(bogusCwd, { recursive: true, force: true });
    }
  });

  test("sets lastSpawnedSize so a re-entry of shutdown on same content is a no-op", async () => {
    vault = createVault({ enabled: true });
    sm = createSession(vault);
    const { api, captured } = makeMockAPI();
    distillExtension(api as never);
    // biome-ignore lint/suspicious/noExplicitAny: partial ctx
    const ctx: any = {
      cwd: vault,
      sessionManager: sm,
      hasUI: false,
      ui: null,
    };
    await captured.handlers.session_start({ reason: "new" }, ctx);
    await captured.handlers.session_shutdown({ reason: "exit" }, ctx);
    const first = countWorktrees(vault);
    expect(first).toBe(1);

    // Re-register & run again without adding new content. The new closure has
    // a fresh lastSpawnedSize=0, so it WILL spawn \u2014 this just confirms that
    // the same-closure re-entry won't (which is what the `lastSpawnedSize =\n    // currentSize` line after a successful spawn guarantees within one run).
    //
    // To truly assert same-closure dedup we'd need to call session_shutdown
    // twice in the same closure, but pi only fires it once per session. The
    // behavior is already unit-tested via shouldDistillOnShutdown; here we
    // just confirm the successful-spawn path writes lastSpawnedSize.
    await captured.handlers.session_shutdown({ reason: "exit" }, ctx);
    const second = countWorktrees(vault);
    // Second call in same closure should NOT create a new worktree \u2014
    // currentSize matches lastSpawnedSize from the first call. The first
    // worktree is still on disk until the detached wrapper's trap runs.
    expect(second).toBe(first);
  });
});
