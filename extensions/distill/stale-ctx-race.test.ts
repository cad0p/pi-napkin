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
 * `session_start`, dropped at the top of `session_shutdown`) makes any
 * queued tick a clean no-op, plus a load-bearing try/catch around the
 * auto-distill tick for the reload-with-cached-module window (an old-session
 * tick queued BEFORE the new `session_start` re-armed the flag passes the
 * guard, then hits the stale ctx and would throw).
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
 *   5. Queued OLD-session tick after NEW session_start → no crash
 *      (the load-bearing try/catch window).
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NAPKIN_MARKER } from "@cad0p/napkin";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanupDistillWorktrees } from "./_test-helpers";
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

  test("queued OLD-session tick after NEW session_start does not crash (load-bearing try/catch)", async () => {
    // The reload-with-cached-module window: an old-session tick is queued
    // BEFORE the new session_start re-armed `sessionActive = true`, so it
    // passes the guard, then hits the stale ctx at `resolveDistillVault
    // (ctx.cwd)` — the FIRST ctx access, before any side effect. Only the
    // tick's try/catch prevents an uncaughtException. The tick logs via
    // console.error (captured below) and performs no work.
    vault = createVault(1);
    const sm = SessionManager.create(vault, vault);
    const ctx1 = makeCtx(sm, vault);
    const { captured } = await startSession(ctx1);
    const firstSessionInterval = capturedIntervals.find((i) => i.ms === 60_000);
    expect(firstSessionInterval).toBeDefined();

    await captured.handlers.session_shutdown({ reason: "new" }, ctx1);
    // New session re-arms the flag on a FRESH ctx...
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
    // The try/catch swallowed the stale-ctx throw at the first ctx access —
    // nothing else in the tick ran, so nothing was spawned.
    expect(tickErrors).toHaveLength(1);
    expect(tickErrors[0]?.[0]).toBe(
      "[napkin-distill] auto-distill tick failed:",
    );
    expect(countWorktrees(vault)).toBe(0);
  });

  test("queued OLD-session poll tick after NEW session_start does not crash (load-bearing try/catch)", async () => {
    // The reload-with-cached-module window, mirrored for the poll loop: an
    // old-session poll tick queued before the new session_start re-armed
    // `sessionActive = true` passes the guard, then hits the stale ctx at
    // `ctx.hasUI` — the first ctx access in the in-flight branch — and
    // only the poll wrapper's try/catch prevents an uncaughtException.
    // The tick logs via console.error (captured below) and performs no
    // work (nothing new is spawned; the session-1 worktree stays).
    vault = createVault(1);
    const sm = SessionManager.create(vault, vault);
    sm.appendMessage({ role: "user", content: "hello" });
    sm.appendMessage({ role: "assistant", content: "hi" });
    const ctx1 = makeCtx(sm, vault);
    const { captured } = await startSession(ctx1);

    // Fire session 1's auto tick → spawns a worktree + registers the
    // 2000ms pollHandle. The spawn sets lastSpawnedSize, so the shutdown
    // below dedupes (guard 8) and spawns nothing.
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
    // New session re-arms the flag on a FRESH ctx...
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
    // The wrapper's try/catch swallowed the stale-ctx throw at the first
    // ctx access — the poll body ran nothing else, so the session-1
    // worktree is still the only one.
    expect(tickErrors).toHaveLength(1);
    expect(tickErrors[0]?.[0]).toBe(
      "[napkin-distill] distill poll tick failed:",
    );
    expect(countWorktrees(vault)).toBe(1);
  });
});
