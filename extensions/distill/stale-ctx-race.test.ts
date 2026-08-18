/**
 * Issue #84 — auto-distill stale-ctx crash after session replacement/reload.
 *
 * Background. pi invalidates the extension ctx captured at `session_start`
 * after any session replacement (`newSession` / `fork` / `switchSession`) or
 * `reload()`: every ctx getter (`cwd`, `hasUI`, `ui`, `sessionManager`)
 * starts throwing `ExtensionRunner.assertActive`'s stale-ctx error. pi's
 * lifecycle runs `session_shutdown` handlers BEFORE invalidation, so the
 * distill timers ARE cleared — but a `setInterval` callback already queued
 * in the macrotask queue still fires after `clearInterval()` (pure JS
 * semantics), and the async shutdown handler can take seconds. A tick
 * landing in that window observes an invalidated ctx, `resolveDistillVault
 * (ctx.cwd)` throws inside the timer callback, and the uncaughtException
 * takes down the whole pi process.
 *
 * Fix: a closure-scoped `sessionActive` liveness flag (armed at the top of
 * `session_start`, dropped at the top of `session_shutdown`) makes any queued
 * tick after shutdown a clean no-op, and a monotonic `sessionGeneration`
 * counter (issue #93) makes a queued OLD-session tick that fires after the
 * next session_start re-armed the flag a clean no-op too — it returns before
 * touching its invalidated ctx, so no throw and no `tick failed` log. The
 * load-bearing try/catches stay as belt-and-braces for genuine current-
 * session errors only.
 *
 * Real pi invalidation is simulated by a ctx whose getters throw the exact
 * stale-ctx error (modelling `ExtensionRunner.assertActive`). The setInterval
 * stub captures callbacks so tests can fire ticks on demand.
 *
 * Test map:
 *   1. Queued auto-distill tick after session_shutdown → clean no-op
 *      (the exact crash repro: before the fix the tick throws, after it skips).
 *   2. Queued poll tick after session_shutdown → clean no-op (no ctx access).
 *   3. Normal tick still spawns a worktree (guard does not block the happy path).
 *   4. Flag re-arms across sessions (reload keeps the cached module closure).
 *   5. Queued OLD-session auto tick after NEW session_start → no throw, no
 *      console.error, no work (issue #93: before the generation guard it
 *      logged `auto-distill tick failed` through the try/catch).
 *   6. Queued OLD-session poll tick after NEW session_start → no throw, no
 *      console.error, no work (same #93 window, mirrored for the poll loop).
 *   7. Queued OLD-session countdown tick after NEW session_start → no render
 *      (pre-#93 it redundantly repainted the status bar through the refreshed
 *      uiRef; the unit under test is the render, not the log).
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NAPKIN_MARKER } from "@cad0p/napkin";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanupDistillWorktrees, makeFakeUI } from "./_test-helpers";
import { resolveCacheRoot } from "./distill-workspace";
import distillExtension from "./index";

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

/** Mirror `createVault` from pollhandle-timeout.test.ts (distill config, git). */
function createVault(intervalMinutes: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-ctx-vault-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@e",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@e",
  };
  const git = (args: string[]) =>
    spawnSync("git", ["-C", dir, ...args], { env, encoding: "utf-8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["config", "user.name", "t"]);
  git(["config", "user.email", "t@e"]);
  fs.writeFileSync(path.join(dir, "seed.md"), "# seed\n");
  fs.mkdirSync(path.join(dir, NAPKIN_MARKER), { recursive: true });
  fs.writeFileSync(
    path.join(dir, NAPKIN_MARKER, "config.json"),
    JSON.stringify({
      // Sibling-layout declaration so napkin resolves contentPath=<dir>
      // (where `.git` and notes live).
      vault: { root: ".." },
      distill: {
        enabled: true,
        onShutdown: true,
        intervalMinutes,
      },
    }),
  );
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed"]);
  return dir;
}

function countWorktrees(vault: string): number {
  const d = resolveCacheRoot(vault);
  if (!fs.existsSync(d)) return 0;
  return fs.readdirSync(d).length;
}

/**
 * The exact error `ExtensionRunner.assertActive` throws once pi has
 * invalidated a ctx after session replacement/reload (verified against pi
 * 0.84.2). Tests assert on the throw itself, not the message, so the string
 * is kept byte-identical for forensic value when a test fails with it.
 */
const STALE_CTX_ERROR_MESSAGE =
  "This extension ctx is stale after session replacement or reload. " +
  "Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). " +
  "For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. " +
  "For reload, do not use the old ctx after await ctx.reload().";

/**
 * Model pi's ctx invalidation on a LIVE ctx object: pi keeps the same object
 * but flips the runner's active flag, so every ctx getter starts throwing.
 * We reproduce that by redefining the four getters the distill extension
 * touches to throw the stale-ctx error. Returns the same object for chaining.
 *
 * Must be called only after the handler that owns the ctx has finished using
 * it (session_start / session_shutdown) — exactly the point where pi would
 * have invalidated it.
 */
function makeCtxStale<T extends Record<string, unknown>>(ctx: T): T {
  const staleError = () => new Error(STALE_CTX_ERROR_MESSAGE);
  for (const key of ["cwd", "hasUI", "ui", "sessionManager"]) {
    Object.defineProperty(ctx, key, {
      configurable: true,
      get: () => {
        throw staleError();
      },
    });
  }
  return ctx;
}

describe("auto-distill stale-ctx race after session replacement (issue #84)", () => {
  let vault: string;
  let originalSetInterval: typeof setInterval;
  let xdgCacheDir: string;

  const _savedRecurse = process.env.NAPKIN_DISTILL_NO_RECURSE;
  const _savedHaltAfterMeta = process.env.NAPKIN_DISTILL_HALT_AFTER_META;
  const _savedXdgCache = process.env.XDG_CACHE_HOME;
  const _savedGitEnv = {
    authorName: process.env.GIT_AUTHOR_NAME,
    authorEmail: process.env.GIT_AUTHOR_EMAIL,
    committerName: process.env.GIT_COMMITTER_NAME,
    committerEmail: process.env.GIT_COMMITTER_EMAIL,
  };

  /**
   * Every `setInterval(cb, ms)` call made during extension registration +
   * session_start + runAutoDistill lands here. The auto-distill tick has
   * `ms === intervalMinutes*60_000`, the pollHandle has `ms === 2000`.
   */
  let capturedIntervals: Array<{ cb: () => void; ms: number }> = [];

  beforeEach(() => {
    delete process.env.NAPKIN_DISTILL_NO_RECURSE;
    xdgCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-ctx-xdg-"));
    process.env.XDG_CACHE_HOME = xdgCacheDir;
    process.env.GIT_AUTHOR_NAME = "Napkin CI";
    process.env.GIT_AUTHOR_EMAIL = "ci@napkin.test";
    process.env.GIT_COMMITTER_NAME = "Napkin CI";
    process.env.GIT_COMMITTER_EMAIL = "ci@napkin.test";
    // Tests 2-4 fire the auto interval, which spawns a REAL worktree
    // distill. HALT_AFTER_META makes the wrapper halt right after the
    // meta.json pid rewrite (clears the EXIT trap, exits 0), keeping the
    // worktree on disk and skipping the napkin shim install — so the tests
    // never race the wrapper and need no napkin on PATH. Harmless for the
    // no-spawn tests (1, 5, 6); keeping it set everywhere is simpler.
    process.env.NAPKIN_DISTILL_HALT_AFTER_META = "1";

    capturedIntervals = [];
    originalSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((
      cb: () => void,
      ms: number,
      ..._rest: unknown[]
    ) => {
      capturedIntervals.push({ cb, ms });
      return {
        unref: () => {},
        ref: () => {},
      } as unknown as NodeJS.Timeout;
    }) as typeof setInterval;
  });

  afterEach(() => {
    if (_savedRecurse !== undefined)
      process.env.NAPKIN_DISTILL_NO_RECURSE = _savedRecurse;
    else delete process.env.NAPKIN_DISTILL_NO_RECURSE;
    if (_savedHaltAfterMeta !== undefined)
      process.env.NAPKIN_DISTILL_HALT_AFTER_META = _savedHaltAfterMeta;
    else delete process.env.NAPKIN_DISTILL_HALT_AFTER_META;
    for (const [key, val] of [
      ["GIT_AUTHOR_NAME", _savedGitEnv.authorName],
      ["GIT_AUTHOR_EMAIL", _savedGitEnv.authorEmail],
      ["GIT_COMMITTER_NAME", _savedGitEnv.committerName],
      ["GIT_COMMITTER_EMAIL", _savedGitEnv.committerEmail],
    ] as const) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    globalThis.setInterval = originalSetInterval;
    if (vault) {
      cleanupDistillWorktrees(vault);
      fs.rmSync(vault, { recursive: true, force: true });
    }
    if (xdgCacheDir) fs.rmSync(xdgCacheDir, { recursive: true, force: true });
    if (_savedXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = _savedXdgCache;
  });

  /**
   * Register the extension and run `session_start` with the given ctx.
   * Returns the mock ctx (so tests can later invalidate it via
   * `makeCtxStale`) and the captured handlers for driving the lifecycle.
   */
  async function startSession(
    ctx: Record<string, unknown>,
  ): Promise<{ api: unknown; captured: CapturedAPI }> {
    const { api, captured } = makeMockAPI();
    distillExtension(api as never);
    await captured.handlers.session_start({ reason: "new" }, ctx);
    return { api, captured };
  }

  /** A ctx shaped like pi's (matching the mock used across distill tests). */
  function makeCtx(sm: SessionManager, cwd: string): Record<string, unknown> {
    return { cwd, sessionManager: sm, hasUI: false, ui: null };
  }

  /**
   * A UI-enabled ctx: session_start arms the countdown timer only when
   * `ctx.hasUI && showStatus` (showStatus defaults true in the createVault
   * config), so this shape is required to arm + assert on countdown renders.
   */
  function makeUICtx(
    sm: SessionManager,
    cwd: string,
    ui: unknown,
  ): Record<string, unknown> {
    return { cwd, sessionManager: sm, hasUI: true, ui };
  }

  test("queued auto-distill tick after session_shutdown is a clean no-op (stale ctx, no crash)", async () => {
    // The exact crash repro from issue #84: a tick queued in the macrotask
    // queue fires after session_shutdown completed and pi invalidated the
    // ctx. Before the fix the tick threw at `resolveDistillVault(ctx.cwd)`
    // (uncaughtException → process death); after the fix the liveness guard
    // makes it a clean no-op.
    //
    // No session messages are appended, so `shouldDistillOnShutdown` guard 7
    // (currentSize === 0) keeps session_shutdown from spawning a real
    // subprocess — the tick assertion must see zero worktrees.
    vault = createVault(1);
    const sm = SessionManager.create(vault, vault);
    const ctx = makeCtx(sm, vault);
    const { captured } = await startSession(ctx);
    await captured.handlers.session_shutdown({ reason: "new" }, ctx);

    // pi has now invalidated the captured ctx — its getters throw.
    makeCtxStale(ctx);
    const autoInterval = capturedIntervals.find((i) => i.ms === 60_000);
    expect(autoInterval).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: verified above
    expect(() => autoInterval!.cb()).not.toThrow();
    expect(countWorktrees(vault)).toBe(0);
  });

  test("queued poll tick after session_shutdown is a clean no-op (stale ctx, no crash)", async () => {
    // A poll tick queued before shutdown fires after invalidation: it must
    // not touch ctx.ui / ctx.sessionManager NOR reset isRunning. The stale
    // getters throw on ANY access, so "no throw" proves the poll callback
    // never reached a ctx getter (the pre-fix code threw at `ctx.hasUI`).
    vault = createVault(1);
    const sm = SessionManager.create(vault, vault);
    sm.appendMessage({ role: "user", content: "hello" });
    sm.appendMessage({ role: "assistant", content: "hi" });
    const ctx = makeCtx(sm, vault);
    const { captured } = await startSession(ctx);

    // Fire the auto-distill tick → spawns a worktree + registers the
    // 2000ms pollHandle. (Appends are safe here: the spawn sets
    // lastSpawnedSize = currentSize, so the shutdown distill dedupes via
    // guard 8 and no second subprocess spawns.)
    const autoInterval = capturedIntervals.find((i) => i.ms === 60_000);
    expect(autoInterval).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: verified above
    autoInterval!.cb();
    expect(countWorktrees(vault)).toBe(1);
    const pollInterval = [...capturedIntervals]
      .reverse()
      .find((i) => i.ms === 2000);
    expect(pollInterval).toBeDefined();

    await captured.handlers.session_shutdown({ reason: "new" }, ctx);
    makeCtxStale(ctx);

    // biome-ignore lint/style/noNonNullAssertion: verified above
    expect(() => pollInterval!.cb()).not.toThrow();
  });

  test("normal auto-distill tick still spawns a worktree (guard does not block the happy path)", async () => {
    // The liveness guard must not change the happy path: a regular tick in
    // an active session spawns exactly one worktree, as before the fix.
    vault = createVault(1);
    const sm = SessionManager.create(vault, vault);
    sm.appendMessage({ role: "user", content: "hello" });
    sm.appendMessage({ role: "assistant", content: "hi" });
    await startSession(makeCtx(sm, vault));

    const autoInterval = capturedIntervals.find((i) => i.ms === 60_000);
    expect(autoInterval).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: verified above
    autoInterval!.cb();
    expect(countWorktrees(vault)).toBe(1);
  });

  test("sessionActive flag re-arms across sessions (reload with cached module closure)", async () => {
    // pi reloads keep the same module closure (all `let` state survives),
    // so the guard must be re-armed by the second session_start. The
    // shutdown uses reason "reload" — pi's actual reload path — which also
    // makes `shouldDistillOnShutdown` guard 2 skip the shutdown spawn.
    vault = createVault(1);
    const sm = SessionManager.create(vault, vault);
    sm.appendMessage({ role: "user", content: "hello" });
    sm.appendMessage({ role: "assistant", content: "hi" });
    const ctx1 = makeCtx(sm, vault);
    const { captured } = await startSession(ctx1);
    await captured.handlers.session_shutdown({ reason: "reload" }, ctx1);

    // Same extension instance, second session on a fresh ctx.
    const ctx2 = makeCtx(sm, vault);
    await captured.handlers.session_start({ reason: "new" }, ctx2);

    // The LAST registered 60_000ms interval belongs to session #2.
    const rearmedInterval = [...capturedIntervals]
      .reverse()
      .find((i) => i.ms === 60_000);
    expect(rearmedInterval).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: verified above
    rearmedInterval!.cb();
    expect(countWorktrees(vault)).toBe(1);
  });

  test("queued OLD-session auto tick after NEW session_start is a clean no-op (no log, no work) — issue #93", async () => {
    // The issue #93 window: an old-session tick queued in the macrotask
    // queue fires AFTER the new session_start re-armed `sessionActive =
    // true`, so the #84 flag check passes. The session generation guard is
    // the only thing that tells this tick it belongs to the OLD session: it
    // returns before `runAutoDistill` touches the invalidated ctx at
    // `resolveDistillVault(ctx.cwd)` — no throw and no work. Pre-#93 this
    // exact window threw inside the tick's try/catch and logged
    // `auto-distill tick failed`; the generation guard makes it silent.
    vault = createVault(1);
    const sm = SessionManager.create(vault, vault);
    const ctx1 = makeCtx(sm, vault);
    const { captured } = await startSession(ctx1);
    const firstSessionInterval = capturedIntervals.find((i) => i.ms === 60_000);
    expect(firstSessionInterval).toBeDefined();

    await captured.handlers.session_shutdown({ reason: "new" }, ctx1);
    // New session re-arms the flag + generation on a FRESH ctx...
    const ctx2 = makeCtx(sm, vault);
    await captured.handlers.session_start({ reason: "new" }, ctx2);
    // ...while the old session's ctx is now invalidated.
    makeCtxStale(ctx1);

    const tickErrors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      tickErrors.push(args);
    };
    try {
      // biome-ignore lint/style/noNonNullAssertion: verified above
      expect(() => firstSessionInterval!.cb()).not.toThrow();
    } finally {
      console.error = originalConsoleError;
    }
    // Silent no-op: zero console.error calls, nothing spawned.
    expect(tickErrors).toHaveLength(0);
    expect(countWorktrees(vault)).toBe(0);
  });

  test("queued OLD-session poll tick after NEW session_start is a clean no-op (no log, no work) — issue #93", async () => {
    // The issue #93 window, mirrored for the poll loop: an old-session poll
    // tick queued before the new session_start re-armed `sessionActive =
    // true` passes the #84 flag check. The session generation guard returns
    // before `pollTick` touches the stale ctx (first access: `ctx.hasUI`),
    // so no throw and no `poll tick failed` log; the session-1 worktree
    // stays the only one. Pre-#93 this window logged through the poll
    // wrapper's try/catch; the generation guard makes it silent.
    vault = createVault(1);
    const sm = SessionManager.create(vault, vault);
    sm.appendMessage({ role: "user", content: "hello" });
    sm.appendMessage({ role: "assistant", content: "hi" });
    const ctx1 = makeCtx(sm, vault);
    const { captured } = await startSession(ctx1);

    // Fire session 1's auto tick → spawns a worktree + registers the
    // 2000ms pollHandle. The shutdown below uses reason "reload", which
    // shouldDistillOnShutdown guard 2 short-circuits (no shutdown spawn);
    // lastSpawnedSize (guard 8) would dedupe it as well for other reasons.
    const firstSessionInterval = capturedIntervals.find((i) => i.ms === 60_000);
    expect(firstSessionInterval).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: verified above
    firstSessionInterval!.cb();
    expect(countWorktrees(vault)).toBe(1);
    const firstSessionPoll = [...capturedIntervals]
      .reverse()
      .find((i) => i.ms === 2000);
    expect(firstSessionPoll).toBeDefined();

    await captured.handlers.session_shutdown({ reason: "reload" }, ctx1);
    // New session re-arms the flag + generation on a FRESH ctx...
    const ctx2 = makeCtx(sm, vault);
    await captured.handlers.session_start({ reason: "new" }, ctx2);
    // ...while the old session's ctx is now invalidated.
    makeCtxStale(ctx1);

    const tickErrors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      tickErrors.push(args);
    };
    try {
      // biome-ignore lint/style/noNonNullAssertion: verified above
      expect(() => firstSessionPoll!.cb()).not.toThrow();
    } finally {
      console.error = originalConsoleError;
    }
    // Silent no-op: zero console.error calls; the session-1 worktree is
    // still the only one and `isRunning` was not touched.
    expect(tickErrors).toHaveLength(0);
    expect(countWorktrees(vault)).toBe(1);
  });

  test("queued OLD-session countdown tick after NEW session_start performs no render (issue #93)", async () => {
    // The countdown callback captures no ctx — it renders through the
    // module-level `uiRef`, which the new session_start has already
    // refreshed — so pre-#93 a queued old countdown tick does NOT throw or
    // log: it performs a duplicate, redundant `setStatus` render through the
    // NEW session's ui. The generation guard makes it a clean no-op; this
    // test asserts on the RENDER (no setStatus call), not the log.
    vault = createVault(1);
    const sm = SessionManager.create(vault, vault);
    // Both sessions need a UI context so each session_start arms its own
    // countdown (armed only when hasUI && showStatus).
    const ui1 = makeFakeUI();
    const ui2 = makeFakeUI();
    const ctx1 = makeUICtx(sm, vault, ui1.ui);
    const { captured } = await startSession(ctx1);
    // The countdown repaints every 1000ms (IDLE_STATUS_REPAINT_INTERVAL_MS).
    const firstSessionCountdown = capturedIntervals.find((i) => i.ms === 1000);
    expect(firstSessionCountdown).toBeDefined();

    await captured.handlers.session_shutdown({ reason: "new" }, ctx1);
    // New session re-arms the flag + generation on a FRESH UI ctx...
    const ctx2 = makeUICtx(sm, vault, ui2.ui);
    await captured.handlers.session_start({ reason: "new" }, ctx2);
    // ...while the old session's ctx is now invalidated.
    makeCtxStale(ctx1);

    // session_start #2 already painted the idle status through ui2; snapshot
    // that count so the assertion targets only the queued-tick render.
    const callsAfterSession2 = ui2.setStatusCalls.length;
    // biome-ignore lint/style/noNonNullAssertion: verified above
    expect(() => firstSessionCountdown!.cb()).not.toThrow();
    // Pre-#93 the queued old tick rendered through the refreshed uiRef and
    // called setStatus again; the generation guard makes it a clean no-op.
    expect(ui2.setStatusCalls.length).toBe(callsAfterSession2);
  });


  test("stale-ctx error inside a tick disarms the auto interval and logs once (issue #95)", async () => {
    // Issue #95 residual window: a tick can pass BOTH the sessionActive and
    // generation guards yet still hold a ctx whose runner was invalidated
    // WITHOUT the matching session_shutdown reaching this closure (a pi-core
    // edge the event-keyed guards cannot see). Pre-fix the interval threw +
    // logged `auto-distill tick failed` on EVERY tick forever. Post-fix the
    // first stale-ctx error disarms the interval and logs ONE notice; the
    // next session_start re-arms cleanly.
    vault = createVault(1);
    const sm = SessionManager.create(vault, vault);
    sm.appendMessage({ role: "user", content: "hello" });
    sm.appendMessage({ role: "assistant", content: "hi" });
    const ctx = makeCtx(sm, vault);
    const { captured } = await startSession(ctx);

    // Simulate the residual window: session is "current" (guards pass) but
    // the ctx is stale. WITHOUT a shutdown in between (the exact pi-core edge).
    makeCtxStale(ctx);

    const autoInterval = capturedIntervals.find((i) => i.ms === 60_000);
    expect(autoInterval).toBeDefined();

    const tickErrors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      tickErrors.push(args);
    };
    try {
      // First tick: throws stale-ctx inside runAutoDistill → disarms + logs once.
      expect(() => autoInterval!.cb()).not.toThrow();
      expect(tickErrors).toHaveLength(1);
      expect(String(tickErrors[0]?.[0])).toContain(
        "[napkin-distill] auto tick hit a stale session ctx",
      );

      // Second tick: interval is disarmed — no new error, no new log.
      expect(() => autoInterval!.cb()).not.toThrow();
      expect(tickErrors).toHaveLength(1);

      // A fresh session_start clears the lockdown and re-arms.
      const ctx2 = makeCtx(sm, vault);
      await captured.handlers.session_start({ reason: "new" }, ctx2);
      expect(() => autoInterval!.cb()).not.toThrow();
      // The re-armed session's tick runs against a valid ctx (no stale error).
      expect(tickErrors).toHaveLength(1);
    } finally {
      console.error = originalConsoleError;
    }
  });
});
