import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { withNapkinOnPath } from "./_test-helpers";
import { resolveCacheRoot, resolveDistillErrorDir } from "./distill-workspace";
import distillExtension from "./index";

/**
 * Tests that verify Item 7 routing:
 *   - the interval timer set up by `session_start` calls `runAutoDistill`,
 *     which creates a git worktree under `$XDG_CACHE_HOME/napkin-distill/<hash>/`
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
      // Sibling-layout declaration so napkin resolves contentPath=<dir>
      // (where `.git` and notes live). Without this, napkin treats this
      // as a legacy embedded vault and resolves contentPath=<dir>/.napkin.
      vault: { root: ".." },
      distill: { enabled: true, intervalMinutes, onShutdown: true },
    }),
  );
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed"]);
  return dir;
}

/**
 * Non-git vault fixture with distill.enabled=true. Used to verify that
 * `/distill` falls back to the legacy tmpdir path when the vault has no
 * `.git/`. Auto-distill's preflight short-circuits this case so it's
 * only exercised by manual `/distill`.
 */
function createEnabledNonGitVault(intervalMinutes: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-nongit-vault-"));
  fs.writeFileSync(
    path.join(dir, "seed.md"),
    "---\ntitle: seed\n---\n# seed\n",
  );
  fs.mkdirSync(path.join(dir, ".napkin"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".napkin", "config.json"),
    JSON.stringify({
      // Sibling-layout declaration so napkin resolves contentPath=<dir>.
      vault: { root: ".." },
      distill: { enabled: true, intervalMinutes, onShutdown: true },
    }),
  );
  // NOTE: no `git init` -- this is the git-less fallback case.
  return dir;
}

/**
 * Git vault fixture with distill.enabled=FALSE. Used to verify that
 * manual `/distill` refuses to use the worktree path (and its scaffolding
 * side effects) when the user has explicitly opted out of auto-distill.
 */
function createDisabledGitVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-disabled-vault-"));
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
      // ENABLED=FALSE — user has explicitly opted out of auto-distill.
      distill: { enabled: false, intervalMinutes: 60, onShutdown: true },
    }),
  );
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed"]);
  return dir;
}

/**
 * Legacy-embedded vault fixture with git initialized on top. napkin's
 * `resolveVaultLayout` returns `contentPath = configPath = <dir>/.napkin`
 * when the config lacks `vault.root`, simulating vaults from pre-subdir
 * napkin versions. This variant adds a git repo on top (rare but
 * possible: user ran `git init` themselves inside `~/.napkin/`).
 *
 * Layout:
 *   <dir>/.napkin/                 <- napkin contentPath == configPath
 *   <dir>/.napkin/.git/            <- user-initialized git repo
 *   <dir>/.napkin/config.json      <- distill.enabled=true, NO vault.root
 *   <dir>/.napkin/seed.md          <- tracked file so HEAD exists
 *
 * Used to verify SEC-R4-1: manual `/distill` on this vault MUST fall
 * back to the legacy tmpdir spawn (not the worktree path), because the
 * worktree path hits the findVault-walks-past-worktree bug on legacy
 * layouts and silently writes to the real vault.
 */
function createEnabledLegacyEmbeddedGitVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-legacy-vault-"));
  const napkinDir = path.join(dir, ".napkin");
  fs.mkdirSync(napkinDir, { recursive: true });
  // NO `vault.root` — napkin treats this as legacy embedded layout, so
  // `configPath === contentPath === <dir>/.napkin/`.
  fs.writeFileSync(
    path.join(napkinDir, "config.json"),
    JSON.stringify({
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

/** Seed a real SessionManager at `dir` (needed because runAutoDistill forks it). */
function createSeededSession(dir: string): SessionManager {
  const sm = SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "hello" });
  sm.appendMessage({ role: "assistant", content: "hi" });
  return sm;
}

// POST-R6-CACHE / R7-CI-2: the detached wrapper is observable only by
// its filesystem effects — the JS test side has no handle to wait on it.
// `waitForWrapperDone` waits until the worktree directory disappears
// (cleanup trap fired — wrapper exited) or a hard timeout. Without this,
// the routing tests pass on a CI runner that has napkin globally
// installed even when the wrapper is broken; with this, a wrapper-side
// failure surfaces in the test output via `assertNoWrapperFailures`.
async function waitForWrapperDone(
  worktreePath: string,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  while (fs.existsSync(worktreePath)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Wrapper did not finish within ${timeoutMs}ms: ${worktreePath}`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

function assertNoWrapperFailures(vault: string): void {
  const errorDir = resolveDistillErrorDir(vault);
  if (!fs.existsSync(errorDir)) return;
  const entries = fs.readdirSync(errorDir);
  if (entries.length === 0) return;
  // Failed: surface the log content for diagnosis.
  const samples = entries
    .slice(0, 3)
    .map((f) => {
      const full = path.join(errorDir, f);
      try {
        return `${f}:\n${fs.readFileSync(full, "utf-8")}`;
      } catch {
        return f;
      }
    })
    .join("\n---\n");
  throw new Error(
    `Wrapper produced ${entries.length} error log(s):\n${samples}`,
  );
}

describe("runAutoDistill vs runDistill routing (Item 7)", () => {
  let vault: string;
  let sm: SessionManager;
  let capturedInterval: (() => void) | null = null;
  let originalSetInterval: typeof setInterval;
  let xdgCacheDir: string;
  const _savedRecurse = process.env.NAPKIN_DISTILL_NO_RECURSE;
  const _savedXdgCache = process.env.XDG_CACHE_HOME;
  // POST-R6-CACHE: shim install requires napkin on PATH; CI runners don't
  // have a global install. Augment via the shared helper. (R7-CI-2.)
  let _napkinPath: { restore: () => void } | null = null;

  beforeEach(() => {
    delete process.env.NAPKIN_DISTILL_NO_RECURSE;
    xdgCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-xdg-"));
    process.env.XDG_CACHE_HOME = xdgCacheDir;
    _napkinPath = withNapkinOnPath();
    // R7-CI-2: stub pi with /usr/bin/true so the wrapper completes
    // quickly during routing tests. Without the stub the wrapper would
    // either spawn the real pi (slow, may hit auth/model errors and
    // write a forensic log) or fail on missing pi (also writes a log).
    // Routing tests assert on routing decisions, not pi behaviour.
    process.env.NAPKIN_DISTILL_PI_BIN = "true";
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
    delete process.env.NAPKIN_DISTILL_PI_BIN;
    globalThis.setInterval = originalSetInterval;
    _napkinPath?.restore();
    _napkinPath = null;
    // Best-effort cleanup of any dangling worktrees + branches the detached
    // wrapper may have left during the test window. Worktrees live under
    // the per-test XDG cache dir set in beforeEach.
    const worktreesDir = resolveCacheRoot(vault);
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
    if (xdgCacheDir) fs.rmSync(xdgCacheDir, { recursive: true, force: true });
    if (_savedXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = _savedXdgCache;
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

    const worktreesDir = resolveCacheRoot(vault);
    expect(
      fs.existsSync(worktreesDir) ? fs.readdirSync(worktreesDir).length : 0,
    ).toBe(0);

    // Invoke the interval callback \u2014 this is what the real setInterval would
    // call on tick. If wiring is correct, it routes to runAutoDistill and
    // creates a worktree synchronously (before detached spawn returns).
    capturedInterval?.();

    // Worktree created under $XDG_CACHE_HOME/napkin-distill/<hash>/. The
    // directory name is the branch suffix (hex-epoch) from createDistillWorkspace.
    expect(fs.existsSync(worktreesDir)).toBe(true);
    const entries = fs.readdirSync(worktreesDir);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatch(/^[0-9a-f]{6}-\d+$/);

    // R7-CI-2: wait for the detached wrapper to finish and assert it
    // didn't write a forensic error log. With NAPKIN_DISTILL_NO_RECURSE
    // set on the spawned wrapper, pi inside the wrapper exits early
    // (no actual distillation), the wrapper proceeds through
    // git add/commit/merge with nothing to commit, and exits 0 — the
    // happy path the cleanup trap removes the worktree on. A wrapper-
    // side failure (missing napkin, broken shebang) lands an error log.
    const wt = path.join(worktreesDir, entries[0]);
    await waitForWrapperDone(wt);
    assertNoWrapperFailures(vault);
  });

  test("/distill on a git-backed vault creates a worktree (matches auto-distill)", async () => {
    const { api, captured } = makeMockExtensionAPI();
    distillExtension(api as never);
    expect(captured.commands.distill).toBeDefined();

    const tmpBefore = new Set(
      fs
        .readdirSync(os.tmpdir())
        .filter((n) => n.startsWith("napkin-distill-")),
    );

    const ctx = makeCtx();
    await captured.commands.distill.handler("", ctx);

    const worktreesDir = resolveCacheRoot(vault);
    expect(fs.existsSync(worktreesDir)).toBe(true);
    const entries = fs.readdirSync(worktreesDir);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatch(/^[0-9a-f]{6}-\d+$/);

    // No legacy tmp dir was created -- git available routes to worktree.
    const tmpAfter = fs
      .readdirSync(os.tmpdir())
      .filter((n) => n.startsWith("napkin-distill-"));
    const newTmpDirs = tmpAfter.filter((n) => !tmpBefore.has(n));
    expect(newTmpDirs.length).toBe(0);

    // R7-CI-2: same wrapper-outcome assertion as the auto-distill test.
    const wt = path.join(worktreesDir, entries[0]);
    await waitForWrapperDone(wt);
    assertNoWrapperFailures(vault);
  });

  test("/distill on a non-git vault falls back to tmp dir (legacy path)", async () => {
    const { api, captured } = makeMockExtensionAPI();
    distillExtension(api as never);
    expect(captured.commands.distill).toBeDefined();

    const nonGitVault = createEnabledNonGitVault(60);
    const nonGitSm = createSeededSession(nonGitVault);
    const nonGitCtx = {
      cwd: nonGitVault,
      sessionManager: nonGitSm,
      hasUI: false,
      ui: null,
    };

    const tmpBefore = new Set(
      fs
        .readdirSync(os.tmpdir())
        .filter((n) => n.startsWith("napkin-distill-")),
    );

    // biome-ignore lint/suspicious/noExplicitAny: mock ctx
    await captured.commands.distill.handler("", nonGitCtx as any);

    // Legacy path: new tmp dir appeared.
    const tmpAfter = fs
      .readdirSync(os.tmpdir())
      .filter((n) => n.startsWith("napkin-distill-"));
    const newTmpDirs = tmpAfter.filter((n) => !tmpBefore.has(n));
    expect(newTmpDirs.length).toBe(1);

    // No worktree under the non-git vault.
    const worktreesDir = resolveCacheRoot(nonGitVault);
    expect(fs.existsSync(worktreesDir)).toBe(false);

    // Cleanup
    for (const d of newTmpDirs) {
      fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
    }
    fs.rmSync(nonGitVault, { recursive: true, force: true });
  });

  test("/distill on a git vault with distill.enabled=false falls back to tmp dir (no git side effects)", async () => {
    const { api, captured } = makeMockExtensionAPI();
    distillExtension(api as never);
    expect(captured.commands.distill).toBeDefined();

    const disabledVault = createDisabledGitVault();
    const disabledSm = createSeededSession(disabledVault);
    const disabledCtx = {
      cwd: disabledVault,
      sessionManager: disabledSm,
      hasUI: false,
      ui: null,
    };

    // Snapshot .gitattributes BEFORE the call — the gate should prevent
    // the worktree path from writing the merge-driver rule to it.
    const gaBefore = fs.existsSync(path.join(disabledVault, ".gitattributes"))
      ? fs.readFileSync(path.join(disabledVault, ".gitattributes"), "utf-8")
      : null;

    const tmpBefore = new Set(
      fs
        .readdirSync(os.tmpdir())
        .filter((n) => n.startsWith("napkin-distill-")),
    );

    // biome-ignore lint/suspicious/noExplicitAny: mock ctx
    await captured.commands.distill.handler("", disabledCtx as any);

    // Legacy path: new tmp dir appeared.
    const tmpAfter = fs
      .readdirSync(os.tmpdir())
      .filter((n) => n.startsWith("napkin-distill-"));
    const newTmpDirs = tmpAfter.filter((n) => !tmpBefore.has(n));
    expect(newTmpDirs.length).toBe(1);

    // No worktree under the disabled-auto-distill vault.
    const worktreesDir = resolveCacheRoot(disabledVault);
    expect(fs.existsSync(worktreesDir)).toBe(false);

    // No git side effects: .gitattributes unchanged (still null — the
    // worktree path would have written our merge-driver rule here).
    const gaAfter = fs.existsSync(path.join(disabledVault, ".gitattributes"))
      ? fs.readFileSync(path.join(disabledVault, ".gitattributes"), "utf-8")
      : null;
    expect(gaAfter).toBe(gaBefore);

    // Cleanup
    for (const d of newTmpDirs) {
      fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
    }
    fs.rmSync(disabledVault, { recursive: true, force: true });
  });

  test("/distill on a legacy-embedded git vault falls back to tmp dir (SEC-R4-1)", async () => {
    // SEC-R4-1: on a legacy-embedded vault (configPath === contentPath,
    // e.g. `~/.napkin/` with no `vault.root`), spawning into a worktree
    // causes napkin's `findVault` (cwd=<worktree>) to walk past the
    // worktree and resolve to the real vault via the global-config
    // fallback — distill writes silently land on the real vault and the
    // worktree stays empty. Manual `/distill` must detect legacy layout
    // and fall back to the legacy tmpdir spawn (which resolves the
    // vault correctly before forking the session).
    const { api, captured } = makeMockExtensionAPI();
    distillExtension(api as never);
    expect(captured.commands.distill).toBeDefined();

    const legacyVault = createEnabledLegacyEmbeddedGitVault();
    // napkin will resolve cwd=<legacyVault>/.napkin to contentPath =
    // configPath = <legacyVault>/.napkin. Seed a session file inside that
    // dir so `runDistillWith` finds it.
    const legacyContentPath = path.join(legacyVault, ".napkin");
    const legacySm = createSeededSession(legacyContentPath);
    const legacyCtx = {
      cwd: legacyContentPath,
      sessionManager: legacySm,
      hasUI: false,
      ui: null,
    };

    // Snapshot .gitattributes BEFORE the call — the legacy-layout gate
    // should prevent the worktree path from writing the merge-driver
    // rule. No .gitattributes exists in the fixture, so the absence
    // before/after confirms no git side effects.
    const gaPath = path.join(legacyContentPath, ".gitattributes");
    const gaBefore = fs.existsSync(gaPath)
      ? fs.readFileSync(gaPath, "utf-8")
      : null;

    const tmpBefore = new Set(
      fs
        .readdirSync(os.tmpdir())
        .filter((n) => n.startsWith("napkin-distill-")),
    );

    // biome-ignore lint/suspicious/noExplicitAny: mock ctx
    await captured.commands.distill.handler("", legacyCtx as any);

    // Legacy path: new tmp dir appeared under $TMPDIR.
    const tmpAfter = fs
      .readdirSync(os.tmpdir())
      .filter((n) => n.startsWith("napkin-distill-"));
    const newTmpDirs = tmpAfter.filter((n) => !tmpBefore.has(n));
    expect(newTmpDirs.length).toBe(1);

    // No worktree under the XDG cache for this vault (the hash is keyed
    // on contentPath, so resolveCacheRoot gives the same answer here as
    // what the worktree path would have used).
    const worktreesDir = resolveCacheRoot(legacyContentPath);
    const entries = fs.existsSync(worktreesDir)
      ? fs.readdirSync(worktreesDir)
      : [];
    expect(entries.length).toBe(0);

    // No git side effects: .gitattributes still absent — the worktree
    // path would have written our merge-driver rule here.
    const gaAfter = fs.existsSync(gaPath)
      ? fs.readFileSync(gaPath, "utf-8")
      : null;
    expect(gaAfter).toBe(gaBefore);

    // Cleanup
    for (const d of newTmpDirs) {
      fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
    }
    fs.rmSync(legacyVault, { recursive: true, force: true });
  });
});
