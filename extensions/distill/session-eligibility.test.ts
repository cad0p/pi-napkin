import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NAPKIN_MARKER } from "@cad0p/napkin";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  cleanupDistillWorktrees,
  makeFakeUI,
  makeMockExtensionAPI,
  makeSubagentCtx,
  makeUICtx,
  withNapkinOnPath,
} from "./_test-helpers";
import { resolveCacheRoot } from "./distill-workspace";
import distillExtension from "./index";
import { isAutoDistillEligible } from "./session-eligibility";

/**
 * Issue #116 — auto-distill fires on subagent (child) sessions.
 *
 * pi-subagents runs every subagent as an in-process `AgentSession` that loads
 * this same extension set, so the distill factory activates once per child with
 * its own `session_start` / `session_shutdown`. Before the fix the child armed
 * the interval (`hasUI` is true there: pi-subagents binds a child UI proxy) and
 * spawned a full distill agent on teardown (the shutdown path had no role
 * gate), on top of the parent's own distill.
 *
 * The fix decides eligibility ONCE in `session_start`
 * (`isAutoDistillEligible`, see ./session-eligibility.ts) and both the interval
 * arm and the shutdown spawn read that flag. The signal is
 * `hasUI && mode !== "print"`: a child reports `hasUI === true` (UI proxy) but
 * keeps pi's default `mode === "print"` (pi-subagents never passes a `mode` to
 * `bindExtensions`), while the TUI binds `"tui"` and RPC binds `"rpc"`.
 *
 * `parentSession` in the session header is NOT the signal: pi also sets it for
 * legitimate top-level forks/clones, so a forked user session must stay
 * eligible (pinned below).
 */

/** Capture auto-distill interval arming without scheduling real timers. */
const armedIntervals: Array<() => void> = [];
const originalSetInterval = globalThis.setInterval;

function installIntervalSpy(): void {
  globalThis.setInterval = ((
    cb: () => void,
    _ms: number,
    ..._rest: unknown[]
  ) => {
    armedIntervals.push(cb);
    return {
      unref: () => {},
      ref: () => {},
    } as unknown as NodeJS.Timeout;
  }) as typeof setInterval;
}

/**
 * Build a napkin vault with distill enabled. `withGit` mirrors
 * shutdown-handler.test.ts: the auto-setup path (git init + seed commit) only
 * runs in an eligible session, so a non-git vault is how the "children skip the
 * per-session setup work" test observes the gate.
 */
function createVault(withGit: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "issue116-vault-"));
  fs.mkdirSync(path.join(dir, NAPKIN_MARKER), { recursive: true });
  fs.writeFileSync(
    path.join(dir, NAPKIN_MARKER, "config.json"),
    JSON.stringify({
      // Sibling layout (napkin >= 0.14 refuses the legacy embedded one).
      vault: { root: ".." },
      distill: { enabled: true, onShutdown: true, intervalMinutes: 60 },
    }),
  );
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
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "seed"]);
  }
  return dir;
}

/** Session with a non-zero file size, optionally nested under a parent session. */
function createSession(dir: string, parentSession?: string): SessionManager {
  const sm = SessionManager.create(
    dir,
    dir,
    parentSession === undefined ? undefined : { parentSession },
  );
  sm.appendMessage({ role: "user", content: "hello" });
  sm.appendMessage({ role: "assistant", content: "hi" });
  return sm;
}

function countWorktrees(vault: string): number {
  const d = resolveCacheRoot(vault);
  if (!fs.existsSync(d)) return 0;
  return fs.readdirSync(d).length;
}

describe("auto-distill session-role signal (issue #116)", () => {
  test("top-level TUI session (hasUI, mode 'tui') is eligible", () => {
    expect(isAutoDistillEligible({ hasUI: true, mode: "tui" })).toBe(true);
  });

  test("RPC host session (hasUI, mode 'rpc') is eligible", () => {
    expect(isAutoDistillEligible({ hasUI: true, mode: "rpc" })).toBe(true);
  });

  test("subagent child (UI proxy + inherited default mode 'print') is NOT eligible", () => {
    // Exactly what pi-subagents' child sees (pi 1.5.2 + 0.22.0): hasUI is
    // true because of createChildUIProxy, mode stays pi's default "print".
    expect(isAutoDistillEligible({ hasUI: true, mode: "print" })).toBe(false);
  });

  test("non-interactive host / subprocess (no UI, mode 'print') is NOT eligible", () => {
    expect(isAutoDistillEligible({ hasUI: false, mode: "print" })).toBe(false);
    // A host that binds no UI is ineligible whatever mode it declares.
    expect(isAutoDistillEligible({ hasUI: false, mode: "tui" })).toBe(false);
  });

  test("legacy ctx without mode keeps the pre-#116 behavior", () => {
    // Older pi / partial hosts do not expose ctx.mode. Treating an absent mode
    // as "allow" avoids silently disabling auto-distill there; the print-mode
    // default only exists on hosts that do expose it.
    expect(isAutoDistillEligible({ hasUI: true })).toBe(true);
    expect(isAutoDistillEligible({ hasUI: false })).toBe(false);
  });
});

describe("auto-distill eligibility wiring (issue #116)", () => {
  let vault: string | null = null;
  let xdgCacheDir: string | null = null;
  const savedRecurse = process.env.NAPKIN_DISTILL_NO_RECURSE;
  const savedXdgCache = process.env.XDG_CACHE_HOME;
  const savedGitEnv = {
    authorName: process.env.GIT_AUTHOR_NAME,
    authorEmail: process.env.GIT_AUTHOR_EMAIL,
    committerName: process.env.GIT_COMMITTER_NAME,
    committerEmail: process.env.GIT_COMMITTER_EMAIL,
  };
  let napkinPath: { restore: () => void } | null = null;

  beforeEach(() => {
    armedIntervals.length = 0;
    delete process.env.NAPKIN_DISTILL_NO_RECURSE;
    xdgCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue116-xdg-"));
    process.env.XDG_CACHE_HOME = xdgCacheDir;
    process.env.GIT_AUTHOR_NAME = "Napkin CI";
    process.env.GIT_AUTHOR_EMAIL = "ci@napkin.test";
    process.env.GIT_COMMITTER_NAME = "Napkin CI";
    process.env.GIT_COMMITTER_EMAIL = "ci@napkin.test";
    napkinPath = withNapkinOnPath();
    installIntervalSpy();
  });

  afterEach(() => {
    globalThis.setInterval = originalSetInterval;
    napkinPath?.restore();
    napkinPath = null;
    if (savedRecurse !== undefined)
      process.env.NAPKIN_DISTILL_NO_RECURSE = savedRecurse;
    else delete process.env.NAPKIN_DISTILL_NO_RECURSE;
    for (const [key, val] of [
      ["GIT_AUTHOR_NAME", savedGitEnv.authorName],
      ["GIT_AUTHOR_EMAIL", savedGitEnv.authorEmail],
      ["GIT_COMMITTER_NAME", savedGitEnv.committerName],
      ["GIT_COMMITTER_EMAIL", savedGitEnv.committerEmail],
    ] as const) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    if (vault) cleanupDistillWorktrees(vault);
    if (vault) fs.rmSync(vault, { recursive: true, force: true });
    vault = null;
    if (xdgCacheDir) fs.rmSync(xdgCacheDir, { recursive: true, force: true });
    xdgCacheDir = null;
    if (savedXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = savedXdgCache;
  });

  test("subagent child: arms no interval and paints no status", async () => {
    vault = createVault(true);
    const sm = createSession(vault, path.join(vault, "parent-session.jsonl"));
    const { api, captured } = makeMockExtensionAPI();
    distillExtension(api as never);
    const { ui, notifyCalls, setStatusCalls } = makeFakeUI();
    // The child's real ctx shape: UI proxy (hasUI true) + pi's default mode.
    const ctx = makeSubagentCtx(sm, vault, ui);

    await captured.handlers.session_start({ reason: "startup" }, ctx);

    expect(armedIntervals).toHaveLength(0);
    expect(setStatusCalls).toEqual([]);
    // No user-facing notify is produced for a child: pi-subagents' UI proxy
    // would forward it into the parent's UI on every subagent spawn.
    expect(notifyCalls).toEqual([]);
  });

  test("subagent child: spawns no distill on session_shutdown", async () => {
    vault = createVault(true);
    const sm = createSession(vault, path.join(vault, "parent-session.jsonl"));
    const { api, captured } = makeMockExtensionAPI();
    distillExtension(api as never);
    const { ui } = makeFakeUI();
    const ctx = makeSubagentCtx(sm, vault, ui);

    await captured.handlers.session_start({ reason: "startup" }, ctx);
    // pi-subagents emits session_shutdown {reason:"quit"} for every settle,
    // stop and reload handover before dispose(). Pre-fix this forked the
    // child's transcript and spawned a full distill agent on it.
    await captured.handlers.session_shutdown({ reason: "quit" }, ctx);

    expect(countWorktrees(vault)).toBe(0);
  });

  test("subagent child: skips the per-session auto-setup work (no git init, no worktree sweep)", async () => {
    // No git in the vault: pre-fix, session_start ran `ensureVaultReadyForDistill`
    // (git init + seed commit) and `cleanupStaleWorktrees` (git worktree list)
    // in EVERY child. Post-fix a child returns before both.
    vault = createVault(false);
    const sm = createSession(vault, path.join(vault, "parent-session.jsonl"));
    const { api, captured } = makeMockExtensionAPI();
    distillExtension(api as never);
    const { ui, notifyCalls } = makeFakeUI();
    const ctx = makeSubagentCtx(sm, vault, ui);

    await captured.handlers.session_start({ reason: "startup" }, ctx);

    expect(fs.existsSync(path.join(vault, ".git"))).toBe(false);
    expect(notifyCalls).toEqual([]);
    expect(armedIntervals).toHaveLength(0);
  });

  test("top-level TUI session: arms the interval and spawns on shutdown", async () => {
    vault = createVault(true);
    const sm = createSession(vault);
    const { api, captured } = makeMockExtensionAPI();
    distillExtension(api as never);
    const { ui } = makeFakeUI();
    const ctx = makeUICtx(sm, vault, ui);

    await captured.handlers.session_start({ reason: "startup" }, ctx);
    expect(armedIntervals.length).toBeGreaterThan(0);

    await captured.handlers.session_shutdown({ reason: "quit" }, ctx);
    expect(countWorktrees(vault)).toBe(1);
  });

  test("top-level TUI session forked from another session stays eligible", async () => {
    // pi records `parentSession` for /fork, /tree branch creation, clone and
    // /new-with-parent — all legitimate top-level user sessions. Gating on the
    // header would silently disable auto-distill for them, so the signal must
    // ignore it; the mode is what marks the child.
    vault = createVault(true);
    const parentFile = path.join(
      vault,
      "2026-01-01T00-00-00-000Z_parent.jsonl",
    );
    const sm = createSession(vault, parentFile);
    expect(sm.getHeader()?.parentSession).toBe(parentFile);

    const { api, captured } = makeMockExtensionAPI();
    distillExtension(api as never);
    const { ui } = makeFakeUI();
    const ctx = makeUICtx(sm, vault, ui);

    await captured.handlers.session_start({ reason: "fork" }, ctx);
    expect(armedIntervals.length).toBeGreaterThan(0);

    await captured.handlers.session_shutdown({ reason: "quit" }, ctx);
    expect(countWorktrees(vault)).toBe(1);
  });
});
