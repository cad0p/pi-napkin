import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { makeFakeUI, makeMockExtensionAPI } from "./_test-helpers";
import { resolveCacheRoot } from "./distill-workspace";
import distillExtension from "./index";

/**
 * Wiring tests for the per-spawn health check (commits 4 / 5).
 *
 * Each test exercises a single spawn entry point (interval tick, manual
 * `/distill`, session_shutdown) on a vault whose health invariants are
 * deliberately broken or healthy, and asserts that the run-time wiring
 * surfaces findings via `ctx.ui.notify` and aborts the spawn when an
 * error finding fires.
 *
 * Health-check side effects are observed indirectly:
 *   - error findings → `ctx.ui.notify(..., "error")` + no worktree dir
 *   - auto-recovered findings → `ctx.ui.notify(..., "info")` + worktree
 *   - healthy vault → no notify of either severity, worktree created
 *
 * Legacy-embedded routing is verified to bypass the health check
 * entirely: `/distill` on those vaults must NOT call
 * `ensureVaultReadyForDistill` (asserted via the absence of any health
 * notify on a vault whose `subdir-layout` invariant would fire if the
 * check ran).
 */

const SUFFICIENTLY_LARGE_INTERVAL_MS = 10_000;

/**
 * Build a subdir-layout vault with `distill.enabled=true` and an initial
 * commit. The vault is a real git repo; the `.napkin/config.json` is
 * the napkin source-of-truth that the health check reads to enforce
 * `config.json-valid-json`.
 */
function createSubdirVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-wiring-vault-"));
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
  fs.mkdirSync(path.join(dir, ".napkin"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".napkin", "config.json"),
    JSON.stringify({
      vault: { root: ".." },
      distill: { enabled: true, intervalMinutes: 60, onShutdown: true },
    }),
  );
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed"]);
  return dir;
}

/**
 * Build a legacy-embedded vault: `configPath === contentPath` because
 * the config has no `vault.root`. Manual `/distill` must route to the
 * legacy tmpdir spawn here, bypassing the health check.
 */
function createLegacyEmbeddedVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-wiring-legacy-"));
  const napkinDir = path.join(dir, ".napkin");
  fs.mkdirSync(napkinDir, { recursive: true });
  fs.writeFileSync(
    path.join(napkinDir, "config.json"),
    JSON.stringify({
      // No `vault.root` — napkin treats this as legacy embedded layout,
      // so `configPath === contentPath === <dir>/.napkin/`.
      distill: { enabled: true, onShutdown: true, intervalMinutes: 60 },
    }),
  );
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "t@e",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "t@e",
  };
  const git = (args: string[]) =>
    spawnSync("git", ["-C", napkinDir, ...args], { env, encoding: "utf-8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["config", "user.name", "t"]);
  git(["config", "user.email", "t@e"]);
  fs.writeFileSync(
    path.join(napkinDir, "seed.md"),
    "---\ntitle: seed\n---\n# seed\n",
  );
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed"]);
  return dir;
}

function createSession(dir: string): SessionManager {
  const sm = SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "hello" });
  sm.appendMessage({ role: "assistant", content: "hi" });
  return sm;
}

describe("per-spawn health-check wiring", () => {
  let xdgCacheDir: string;
  const _savedRecurse = process.env.NAPKIN_DISTILL_NO_RECURSE;
  const _savedXdgCache = process.env.XDG_CACHE_HOME;
  const _savedPiBin = process.env.NAPKIN_DISTILL_PI_BIN;
  let originalSetInterval: typeof setInterval;
  let capturedInterval: (() => void) | null = null;

  beforeEach(() => {
    delete process.env.NAPKIN_DISTILL_NO_RECURSE;
    xdgCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "health-wiring-xdg-"));
    process.env.XDG_CACHE_HOME = xdgCacheDir;
    // Stub pi with /usr/bin/true so any wrapper that does spawn exits
    // immediately. The tests assert on JS-side wiring (notify + presence
    // of a worktree dir) before the wrapper has a chance to do anything
    // meaningful.
    process.env.NAPKIN_DISTILL_PI_BIN = "true";

    // Capture the distill interval (the > 10s one) so the test can
    // invoke runAutoDistill deterministically.
    originalSetInterval = globalThis.setInterval;
    capturedInterval = null;
    globalThis.setInterval = ((
      cb: () => void,
      ms: number,
      ...rest: unknown[]
    ) => {
      if (ms > SUFFICIENTLY_LARGE_INTERVAL_MS && capturedInterval === null) {
        capturedInterval = cb;
        return { unref: () => {}, ref: () => {} } as unknown as NodeJS.Timeout;
      }
      return originalSetInterval(cb, ms, ...rest);
    }) as typeof setInterval;
  });

  afterEach(() => {
    if (_savedRecurse !== undefined)
      process.env.NAPKIN_DISTILL_NO_RECURSE = _savedRecurse;
    else delete process.env.NAPKIN_DISTILL_NO_RECURSE;
    if (_savedPiBin !== undefined)
      process.env.NAPKIN_DISTILL_PI_BIN = _savedPiBin;
    else delete process.env.NAPKIN_DISTILL_PI_BIN;
    if (_savedXdgCache !== undefined)
      process.env.XDG_CACHE_HOME = _savedXdgCache;
    else delete process.env.XDG_CACHE_HOME;
    globalThis.setInterval = originalSetInterval;
    if (xdgCacheDir) fs.rmSync(xdgCacheDir, { recursive: true, force: true });
  });

  function worktreeCount(vault: string): number {
    const dir = resolveCacheRoot(vault);
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).length;
  }

  // --- runAutoDistill (interval tick) ------------------------------------

  test("runAutoDistill on healthy vault: no error notify, worktree created", async () => {
    const vault = createSubdirVault();
    try {
      const sm = createSession(vault);
      const { ui, notifyCalls } = makeFakeUI();
      const ctx = { cwd: vault, sessionManager: sm, hasUI: true, ui };

      const { api, captured } = makeMockExtensionAPI();
      distillExtension(api as never);
      // biome-ignore lint/suspicious/noExplicitAny: mock ctx
      await captured.handlers.session_start({ reason: "new" }, ctx as any);
      // session_start drains its own notifies (block install on a fresh
      // vault). Clear the buffer so we only see notifies from runAutoDistill.
      notifyCalls.length = 0;

      capturedInterval?.();

      // Healthy vault on the second pass: gitignore block already in place
      // from session_start, no findings, no notify.
      expect(notifyCalls.filter((n) => n.severity === "error")).toEqual([]);
      expect(notifyCalls.filter((n) => n.severity === "info")).toEqual([]);
      expect(worktreeCount(vault)).toBe(1);
    } finally {
      // Cleanup any worktrees the wrapper may have created
      const dir = resolveCacheRoot(vault);
      if (fs.existsSync(dir)) {
        for (const entry of fs.readdirSync(dir)) {
          spawnSync(
            "git",
            [
              "-C",
              vault,
              "worktree",
              "remove",
              "--force",
              path.join(dir, entry),
            ],
            { encoding: "utf-8" },
          );
        }
      }
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });

  test("runAutoDistill on vault with malformed gitignore markers: error notify, no worktree", async () => {
    const vault = createSubdirVault();
    try {
      const sm = createSession(vault);
      const { ui, notifyCalls } = makeFakeUI();
      const ctx = { cwd: vault, sessionManager: sm, hasUI: true, ui };

      const { api, captured } = makeMockExtensionAPI();
      distillExtension(api as never);
      // biome-ignore lint/suspicious/noExplicitAny: mock ctx
      await captured.handlers.session_start({ reason: "new" }, ctx as any);
      expect(capturedInterval).not.toBeNull();

      // Synthesise a malformed managed-block by stripping the END marker.
      // The full-level check at the next interval fires the
      // gitignore-block-correct error finding.
      const giPath = path.join(vault, ".gitignore");
      const gi = fs.readFileSync(giPath, "utf-8");
      fs.writeFileSync(
        giPath,
        gi.replace("# END NAPKIN-DISTILL MANAGED\n", ""),
      );
      notifyCalls.length = 0;

      capturedInterval?.();

      const errors = notifyCalls.filter((n) => n.severity === "error");
      expect(errors.length).toBe(1);
      expect(errors[0].msg).toContain("malformed");
      expect(worktreeCount(vault)).toBe(0);
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });

  test("runAutoDistill on vault with reset .gitignore: info notify, worktree created", async () => {
    const vault = createSubdirVault();
    try {
      const sm = createSession(vault);
      const { ui, notifyCalls } = makeFakeUI();
      const ctx = { cwd: vault, sessionManager: sm, hasUI: true, ui };

      const { api, captured } = makeMockExtensionAPI();
      distillExtension(api as never);
      // biome-ignore lint/suspicious/noExplicitAny: mock ctx
      await captured.handlers.session_start({ reason: "new" }, ctx as any);

      // Wipe the managed-block content from .gitignore so the next
      // full-level call detects drift and reinstalls (auto-recovered).
      fs.writeFileSync(path.join(vault, ".gitignore"), "# user-only\n");
      notifyCalls.length = 0;

      capturedInterval?.();

      const errors = notifyCalls.filter((n) => n.severity === "error");
      const infos = notifyCalls.filter((n) => n.severity === "info");
      expect(errors).toEqual([]);
      expect(infos.length).toBe(1);
      expect(infos[0].msg).toContain("recovered");
      expect(worktreeCount(vault)).toBe(1);
    } finally {
      const dir = resolveCacheRoot(vault);
      if (fs.existsSync(dir)) {
        for (const entry of fs.readdirSync(dir)) {
          spawnSync(
            "git",
            [
              "-C",
              vault,
              "worktree",
              "remove",
              "--force",
              path.join(dir, entry),
            ],
            { encoding: "utf-8" },
          );
        }
      }
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });

  // --- runDistill (manual /distill on subdir-layout) ---------------------

  test("/distill on subdir-layout vault with malformed gitignore markers: error notify, no worktree", async () => {
    const vault = createSubdirVault();
    try {
      const sm = createSession(vault);
      const { ui, notifyCalls } = makeFakeUI();
      const ctx = { cwd: vault, sessionManager: sm, hasUI: true, ui };

      const { api, captured } = makeMockExtensionAPI();
      distillExtension(api as never);
      // biome-ignore lint/suspicious/noExplicitAny: mock ctx
      await captured.handlers.session_start({ reason: "new" }, ctx as any);

      // Synthesise malformed markers so the full-level check at /distill
      // fires the error finding.
      const giPath = path.join(vault, ".gitignore");
      const gi = fs.readFileSync(giPath, "utf-8");
      fs.writeFileSync(
        giPath,
        gi.replace("# END NAPKIN-DISTILL MANAGED\n", ""),
      );
      notifyCalls.length = 0;

      // biome-ignore lint/suspicious/noExplicitAny: mock ctx
      await captured.commands.distill.handler("", ctx as any);

      const errors = notifyCalls.filter((n) => n.severity === "error");
      expect(errors.length).toBe(1);
      expect(errors[0].msg).toContain("malformed");
      expect(worktreeCount(vault)).toBe(0);
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });

  test("/distill on legacy-embedded vault: NO health-check called (no notify, falls back to legacy spawn)", async () => {
    // The legacy-embedded vault would fire a `subdir-layout` error finding
    // if the health check ran on it. The wiring contract is that
    // legacy-embedded routing in `runDistill` skips the health check
    // entirely, so we must see ZERO notify activity from the helper.
    const legacyVault = createLegacyEmbeddedVault();
    const legacyContent = path.join(legacyVault, ".napkin");
    try {
      const sm = createSession(legacyContent);
      const { ui, notifyCalls } = makeFakeUI();
      const ctx = {
        cwd: legacyContent,
        sessionManager: sm,
        hasUI: true,
        ui,
      };

      const { api, captured } = makeMockExtensionAPI();
      distillExtension(api as never);

      const tmpBefore = new Set(
        fs
          .readdirSync(os.tmpdir())
          .filter((n) => n.startsWith("napkin-distill-")),
      );

      // biome-ignore lint/suspicious/noExplicitAny: mock ctx
      await captured.commands.distill.handler("", ctx as any);

      // No health-check notifications fired (the helper wraps every
      // notify with `Auto-distill ...` so any presence of those strings
      // would be a regression).
      const healthNotifies = notifyCalls.filter((n) =>
        n.msg.startsWith("Auto-distill"),
      );
      expect(healthNotifies).toEqual([]);

      // Legacy spawn fired: a new tmp dir appeared.
      const tmpAfter = fs
        .readdirSync(os.tmpdir())
        .filter((n) => n.startsWith("napkin-distill-"));
      const newTmp = tmpAfter.filter((n) => !tmpBefore.has(n));
      expect(newTmp.length).toBe(1);
      // No worktree was created.
      expect(worktreeCount(legacyContent)).toBe(0);

      for (const d of newTmp) {
        fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(legacyVault, { recursive: true, force: true });
    }
  });

  // --- session_shutdown handler ------------------------------------------

  test("session_shutdown on vault with malformed gitignore markers: error notify, no worktree", async () => {
    const vault = createSubdirVault();
    try {
      const sm = createSession(vault);
      const { ui, notifyCalls } = makeFakeUI();
      const ctx = { cwd: vault, sessionManager: sm, hasUI: true, ui };

      const { api, captured } = makeMockExtensionAPI();
      distillExtension(api as never);
      // biome-ignore lint/suspicious/noExplicitAny: mock ctx
      await captured.handlers.session_start({ reason: "new" }, ctx as any);

      // Make a session-file change to bypass the size-dedup guard.
      sm.appendMessage({ role: "user", content: "more content" });

      // Synthesise malformed markers so the full-level check at shutdown
      // fires the error finding.
      const giPath = path.join(vault, ".gitignore");
      const gi = fs.readFileSync(giPath, "utf-8");
      fs.writeFileSync(
        giPath,
        gi.replace("# END NAPKIN-DISTILL MANAGED\n", ""),
      );
      notifyCalls.length = 0;

      await captured.handlers.session_shutdown(
        { reason: "user-quit" },
        // biome-ignore lint/suspicious/noExplicitAny: mock ctx
        ctx as any,
      );

      const errors = notifyCalls.filter((n) => n.severity === "error");
      expect(errors.length).toBe(1);
      expect(errors[0].msg).toContain("malformed");
      expect(worktreeCount(vault)).toBe(0);
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });
});
