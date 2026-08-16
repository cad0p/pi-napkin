/**
 * Shared test helpers for the distill extension.
 *
 * Keep this file lightweight: small, well-scoped helpers used across
 * multiple test files. Anything that grows past ~30 LOC or pulls in
 * heavy deps probably belongs in its own file.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { NAPKIN_MARKER } from "@cad0p/napkin";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createDistillWorkspace, resolveCacheRoot } from "./distill-workspace";
import { DISTILL_WRAPPER_SCRIPT } from "./scripts-paths";

/**
 * Kill any detached distill wrapper subprocess still running for the
 * given vault. The wrapper writes its own pid to each worktree's
 * `meta.json` on startup; read those, SIGTERM the pids, and wait briefly
 * for exit. This must run BEFORE `git worktree remove` / `fs.rmSync` in
 * test teardown — otherwise the wrapper's cleanup trap races the test's
 * `afterEach` and `fs.rmSync(vault)` fails with ENOTEMPTY (file handles
 * still held by the not-yet-exited wrapper).
 *
 * No-op when no worktrees exist or no meta.json is readable. Pids that
 * are already dead (ESRCH on kill) are silently skipped.
 *
 * LIMITATION (Flake A, issue #49): the wrapper's pid record lives in
 * meta.json INSIDE the worktree, which the wrapper's EXIT trap deletes
 * before the wrapper exits. So once a worktree has disappeared this
 * helper has nothing to kill — the wrapper may still be alive mid-trap
 * (it `cd`s into the vault and runs `git -C <vault> prune` + `branch -D`
 * after removing the worktree, holding the vault as cwd). Teardown must
 * pair this with `retryRmSync` (bounded ENOTEMPTY retry) and/or an
 * explicit wait for the wrapper pid to exit (see `waitForWrapperDone`
 * in routing.test.ts).
 */
export function killDistillWrappers(vault: string): void {
  const cacheRoot = resolveCacheRoot(vault);
  if (!fs.existsSync(cacheRoot)) return;
  for (const entry of fs.readdirSync(cacheRoot)) {
    const metaPath = path.join(
      cacheRoot,
      entry,
      NAPKIN_MARKER,
      "distill",
      "meta.json",
    );
    let pid: number | undefined;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      if (typeof meta.pid === "number") pid = meta.pid;
    } catch {
      // No meta.json or unreadable — nothing to kill.
    }
    if (pid === undefined || pid <= 0) continue;
    try {
      // Kill the wrapper's entire process group (negative pid) so any
      // children it spawned (git, the agent stub) also exit and release
      // file handles. The wrapper is detached so it leads its own group.
      process.kill(-pid, "SIGTERM");
    } catch (e) {
      // ESRCH = already dead; ignore. Anything else is unexpected but
      // non-fatal in teardown — don't mask the real test failure.
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") continue;
    }
    // Wait up to ~1s for the wrapper to exit so its file handles release
    // before the caller removes the worktree / vault dir. (Was ~300ms;
    // too tight for loaded CI runners — Flake A, issue #49.) Note the
    // pid is only readable while the worktree still exists: meta.json
    // lives inside the worktree, which the wrapper's EXIT trap deletes
    // BEFORE the wrapper exits. If the worktree is already gone there is
    // nothing to kill here — the caller must use `retryRmSync` (bounded
    // ENOTEMPTY retry) and/or wait for the wrapper pid to exit instead.
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(pid, 0);
        // Still alive — wait 10ms and retry.
        spawnSync("sleep", ["0.01"], { shell: false });
      } catch {
        break; // ESRCH — exited.
      }
    }
  }
}

/**
 * Bounded retry for teardown `rmSync` of directories that spawned
 * detached subprocesses may still hold (Flake A root-cause net,
 * issue #49).
 *
 * `fs.rmSync(target, { recursive: true, force: true })` fails with
 * ENOTEMPTY when a just-killed or exiting subprocess still holds handles
 * inside `target` (on macOS a directory that is a live process's cwd
 * cannot be removed — the wrapper's EXIT trap `cd`s into the vault and
 * runs `git -C <vault> prune`/`branch -D` AFTER removing the worktree,
 * so the worktree-dir-gone signal does NOT mean the vault is free).
 * `force: true` only ignores ENOENT, never retries ENOTEMPTY/EBUSY.
 *
 * Retries ENOTEMPTY/EBUSY a bounded number of times (default 20 × 50ms
 * = 1s total) so teardown is deterministic without risking a CI hang;
 * any other error rethrows immediately (genuine failures must surface,
 * not be masked by retries), and the last error is rethrown after the
 * bound is exhausted.
 *
 * `opts.fs` / `opts.attempts` / `opts.delayMs` exist for unit tests
 * (fake fs that fails N times, zero delay) — see _test-helpers.test.ts.
 */
export function retryRmSync(
  target: string,
  opts: {
    fs?: typeof import("node:fs");
    attempts?: number;
    delayMs?: number;
  } = {},
): void {
  const fsImpl = opts.fs ?? fs;
  const attempts = opts.attempts ?? 20;
  const delayMs = opts.delayMs ?? 50;
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      fsImpl.rmSync(target, { recursive: true, force: true });
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EBUSY") {
        // Another process still holds handles inside `target` — give it
        // a brief moment to release them, then retry.
        if (delayMs > 0) {
          spawnSync("sleep", [String(delayMs / 1000)], { shell: false });
        }
        continue;
      }
      // Genuine error (EACCES, EPERM, ...): surface immediately.
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Remove all distill worktrees for a vault: kill any live wrapper pids
 * (see `killDistillWrappers`), then `git worktree remove --force` each
 * and prune. Centralizes the cleanup that was duplicated across
 * shutdown-handler, health-check-wiring, and pollhandle-timeout tests.
 */
export function cleanupDistillWorktrees(vault: string): void {
  killDistillWrappers(vault);
  const d = resolveCacheRoot(vault);
  if (!fs.existsSync(d)) return;
  for (const entry of fs.readdirSync(d)) {
    const wt = path.join(d, entry);
    spawnSync("git", ["-C", vault, "worktree", "remove", "--force", wt], {
      encoding: "utf-8",
    });
  }
  spawnSync("git", ["-C", vault, "worktree", "prune"], { encoding: "utf-8" });
}

/**
 * Absolute path of the directory holding `timeout(1)` (or `gtimeout`
 * on macOS-with-Homebrew-coreutils). The wrapper hard-fails at
 * startup if neither is reachable (CI-A-1 / CLEAN-A-1 / SEC-A-3),
 * which means tests that deliberately strip PATH must still preserve
 * this dir to exercise downstream guards (missing-node, missing-napkin,
 * etc.) instead of bailing at the timeout check.
 *
 * On Linux, `timeout` lives in `/usr/bin` (GNU coreutils). On macOS,
 * Homebrew installs `gtimeout` in `/opt/homebrew/bin` (Apple Silicon)
 * or `/usr/local/bin` (Intel) — neither of which is in the typical
 * `/usr/bin:/bin` stripped PATH. Resolving via `command -v` at module
 * load mirrors how the wrapper itself locates the binary.
 *
 * Falls back to `/usr/bin` if neither is on PATH; in that case any
 * timeout-dependent test will (correctly) fail and surface the
 * missing-coreutils issue at its assertion rather than silently here.
 */
const TIMEOUT_PATH =
  spawnSync("sh", ["-c", "command -v timeout || command -v gtimeout"], {
    encoding: "utf-8",
  }).stdout.trim() || "/usr/bin/timeout";
export const TIMEOUT_BIN_DIR = path.dirname(TIMEOUT_PATH);

/**
 * Augment `process.env.PATH` so the spawned wrapper can resolve `napkin`
 * via `command -v` (R7-CI-1 — the wrapper's `--version` smoke test
 * needs the binary on PATH from `node_modules/.bin/`).
 *
 * After `bun install` napkin lives at `<repo>/node_modules/.bin/napkin`
 * (a symlink with `#!/usr/bin/env node` shebang). Test environments
 * typically don't have napkin on the global PATH, so wrapper-spawning
 * tests need to prepend the local bin dir.
 *
 * Contract:
 *   - Mutates `process.env.PATH` in place. The Bun spawn API inherits
 *     the parent's env, so a wrapper spawned after the call sees the
 *     augmented PATH automatically.
 *   - Returns a `{ restore }` handle the caller MUST call (typically in
 *     `afterEach`) to revert.
 *   - Capture happens at call time (NOT module load), so each test's
 *     beforeEach gets a fresh snapshot. Avoids the brittle
 *     module-load-const pattern that R7-SC-6 / R7-CC-2 flagged.
 *   - Throws if `node_modules/.bin/` doesn't exist (R8-CI-1, R8-SC-10).
 *     The previous silent-no-op behaviour caused wrapper-spawning
 *     tests to fail with the wrapper's `napkin not found on PATH`
 *     diagnostic when a developer ran `bun test` before `bun install`,
 *     pointing at the wrapper instead of at the missing setup step.
 *     Failing here surfaces the actual problem at the helper.
 *
 * Repo-root resolution: `__dirname` resolves to this helper's directory
 * (`extensions/distill/`), so `../../node_modules/.bin/` is the repo's
 * regardless of which test file imports the helper.
 */
export function withNapkinOnPath(): { restore: () => void } {
  const localBin = path.resolve(__dirname, "..", "..", "node_modules", ".bin");
  if (!fs.existsSync(localBin)) {
    throw new Error(
      `withNapkinOnPath: ${localBin} does not exist. Run \`bun install\` ` +
        `before \`bun test\` so the wrapper-spawning tests can resolve \`napkin\`.`,
    );
  }
  const saved = process.env.PATH;
  process.env.PATH = `${localBin}${path.delimiter}${process.env.PATH ?? ""}`;
  return {
    restore() {
      if (saved === undefined) delete process.env.PATH;
      else process.env.PATH = saved;
    },
  };
}

// ---------------------------------------------------------------------------
// Wrapper-spawning test scaffolding (CLEAN-A-6)
//
// Shared across `wrapper-validation.test.ts` and `wrapper-salvage.test.ts`,
// which both drive `distill-wrapper.sh` end-to-end with a stubbed `pi`
// binary. Phase C will reuse these for additional bash-stub fixtures
// (~10 mocked-pi behaviors), so factoring them once now keeps the per-
// test-file size manageable.
// ---------------------------------------------------------------------------

/**
 * Test scaffold layout per case:
 *   <root>/vault/         — main vault (git-init, default branch `main`,
 *                           one seed commit so `<seed-sha>..HEAD`
 *                           rev-list semantics work)
 *   <root>/parent/        — parent pi cwd
 *   <root>/sessions/      — session file dir
 *   <root>/vault/.napkin/distill/errors/ — error/outcome sidecar dir
 *   <root>/stub-pi        — the agent stub script (caller writes it)
 */
export interface WrapperScaffold {
  root: string;
  vault: string;
  parentCwd: string;
  sessionFile: string;
  errorDir: string;
  stubPi: string;
}

/**
 * Build a fresh test scaffold per test. Creates a git-init'd vault with
 * one seed commit, a parent cwd, an empty session file, and the error
 * dir. Caller is responsible for `fs.rmSync(scaffold.root, { recursive:
 * true, force: true })` in a `finally` block.
 *
 * @param prefix mkdtemp prefix (e.g. `"napkin-distill-a3-"`); use
 *               distinct prefixes per test file so concurrent test
 *               failures leave readable `/tmp` debris.
 */
export function makeWrapperScaffold(prefix: string): WrapperScaffold {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const vault = path.join(root, "vault");
  const parentCwd = path.join(root, "parent");
  const sessionsDir = path.join(root, "sessions");
  const errorDir = path.join(vault, NAPKIN_MARKER, "distill", "errors");
  const stubPi = path.join(root, "stub-pi");

  fs.mkdirSync(vault);
  fs.mkdirSync(parentCwd);
  fs.mkdirSync(sessionsDir);
  fs.mkdirSync(errorDir, { recursive: true });

  // git init + seed commit. Use -b main so detectDefaultBranch resolves.
  spawnSync("git", ["init", "-b", "main", vault], { encoding: "utf-8" });
  spawnSync("git", ["-C", vault, "config", "user.email", "test@example.com"]);
  spawnSync("git", ["-C", vault, "config", "user.name", "test"]);
  fs.writeFileSync(path.join(vault, "seed.md"), "# seed\n");
  spawnSync("git", ["-C", vault, "add", "."]);
  spawnSync("git", ["-C", vault, "commit", "-m", "seed"]);

  const sm = SessionManager.create(parentCwd, sessionsDir);
  // appendMessage's typed-parts shape: pi-coding-agent's Message types
  // require timestamp on every message and an array-of-parts content for
  // assistant messages (UserMessage still accepts string). The fixture
  // below is the minimum that satisfies the SDK types; downstream
  // consumers only care that the JSONL exists and parses, not its
  // contents.
  sm.appendMessage({
    role: "user",
    content: "hello",
    timestamp: Date.now(),
  });
  sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    api: "faux",
    provider: "faux",
    model: "faux",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const sessionFile = sm.getSessionFile();
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    throw new Error("failed to create test session on disk");
  }

  return { root, vault, parentCwd, sessionFile, errorDir, stubPi };
}

/**
 * Write a stub `pi` binary. The body is whatever the test wants the
 * agent to do; positional args are ignored unless the body parses
 * them. `chmod +x`, then return the path so the caller can pass it
 * as `NAPKIN_DISTILL_PI_BIN`.
 */
export function writePiStub(
  scaffold: WrapperScaffold,
  bodyScript: string,
): string {
  const stub = `#!/usr/bin/env bash\nset -e\n${bodyScript}\n`;
  fs.writeFileSync(scaffold.stubPi, stub, { mode: 0o755 });
  return scaffold.stubPi;
}

/**
 * Run the wrapper end-to-end against the given scaffold and stub pi.
 *
 * The wrapper's argv shape (PR #12 A2): vault, worktree, branch,
 * sessionFork, prompt, errorDir, model, defaultBranch, parentCwd,
 * maxDurationSecs.
 *
 * Returns:
 *   - exitCode / stderr  — the wrapper process's status & stderr
 *   - branch / workspace — the distill workspace this run targeted
 *   - preSha             — vault main HEAD captured BEFORE the wrapper
 *                          runs (used by salvage tests to assert main
 *                          history wasn't reset by the salvage path)
 *   - outcome / outcomePath — line 1 of the outcome sidecar (the
 *                          canonical class string) and its path, or
 *                          null if no sidecar was written. Multi-line
 *                          sidecars (`failed:*` classes carry a
 *                          recovery hint on lines 2+) collapse to
 *                          line 1 for the canonical class — same
 *                          shape as the JS-side
 *                          `findDistillOutcomeForBranch`.
 *
 * `opts.fixturePath` (PR #12 C2): when set, the helper skips the
 * `writePiStub` step (caller arranged the agent stub elsewhere — e.g.
 * a fixture file under `test-fixtures/agent-stubs/`) and points
 * `NAPKIN_DISTILL_PI_BIN` directly at the fixture. The helper also
 * auto-injects `NAPKIN_STUB_VAULT`, `NAPKIN_STUB_WORKTREE`,
 * `NAPKIN_STUB_BRANCH`, and `NAPKIN_STUB_DEFAULT_BRANCH` so the
 * fixture script can reach the test scaffold's paths without
 * JS-side template-string interpolation.
 */
export function runWrapperWithStub(
  scaffold: WrapperScaffold,
  opts: {
    skipPi?: boolean;
    extraEnv?: Record<string, string>;
    maxDurationSecs?: string;
    fixturePath?: string;
  } = {},
): {
  exitCode: number;
  stderr: string;
  outcome: string | null;
  outcomePath: string | null;
  branch: string;
  workspace: ReturnType<typeof createDistillWorkspace>;
  preSha: string;
} {
  const workspace = createDistillWorkspace(
    scaffold.vault,
    scaffold.sessionFile,
    scaffold.parentCwd,
  );
  const branch = workspace.branchName;
  const preSha = spawnSync("git", ["-C", scaffold.vault, "rev-parse", "main"], {
    encoding: "utf-8",
  }).stdout.trim();

  const env: Record<string, string> = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    NAPKIN_DISTILL_NO_RECURSE: "1",
    NAPKIN_DISTILL_PI_BIN: opts.fixturePath ?? scaffold.stubPi,
    // PR #12 C2: when running against a formal fixture script, expose
    // the scaffold's paths via NAPKIN_STUB_* env vars so the fixture
    // can reach them without JS-side template-string interpolation.
    // Always set (even for inline-stub runs) — fixtures-driven tests
    // are the only consumers; inline stubs ignore them.
    NAPKIN_STUB_VAULT: scaffold.vault,
    NAPKIN_STUB_WORKTREE: workspace.worktreePath,
    NAPKIN_STUB_BRANCH: branch,
    NAPKIN_STUB_DEFAULT_BRANCH: "main",
    ...(opts.extraEnv ?? {}),
  };
  if (opts.skipPi) {
    env.NAPKIN_DISTILL_SKIP_PI = "1";
  }

  const r = spawnSync(
    "bash",
    [
      DISTILL_WRAPPER_SCRIPT,
      scaffold.vault,
      workspace.worktreePath,
      branch,
      workspace.sessionForkPath,
      "test prompt",
      scaffold.errorDir,
      "",
      "main",
      scaffold.parentCwd,
      opts.maxDurationSecs ?? "60",
      // SEC-2 / CORR-3: cache root is the worktree's parent dir per
      // the cache layout `<cache-root>/<branch-suffix>/`. The wrapper
      // hard-fails at startup if this 11th positional arg is empty;
      // safe_rm_worktree's descendant check requires it.
      path.dirname(workspace.worktreePath),
    ],
    {
      cwd: scaffold.parentCwd,
      encoding: "utf-8",
      env,
    },
  );

  // Locate the outcome sidecar. The wrapper names it
  // `<ts>-<pid>-<branchShort>.outcome`. PR #12 A4 made the file
  // multi-line for `failed:*` classes (line 1 = class, lines 2+ =
  // recovery hint); use only line 1 as the canonical class string.
  const branchShort = branch.replace(/^distill\//, "");
  const outcomeFiles = fs.existsSync(scaffold.errorDir)
    ? fs
        .readdirSync(scaffold.errorDir)
        .filter((f) => f.endsWith(`-${branchShort}.outcome`))
    : [];
  let outcome: string | null = null;
  let outcomePath: string | null = null;
  if (outcomeFiles.length === 1) {
    outcomePath = path.join(scaffold.errorDir, outcomeFiles[0]);
    const raw = fs.readFileSync(outcomePath, "utf-8");
    outcome = (raw.split("\n")[0] ?? "").trim();
  }

  return {
    exitCode: r.status ?? -1,
    stderr: r.stderr ?? "",
    outcome,
    outcomePath,
    branch,
    workspace,
    preSha,
  };
}

// ---------------------------------------------------------------------------
// Fake UI + mock ExtensionAPI factories
//
// Used by routing tests and by `scripts/verify-e2e.ts`. Both factories build
// minimal stubs that capture observable side effects (notify calls, command
// registrations) without pulling in the full pi runtime.
//
// Property name `msg` (not `message`) matches the existing capture shape
// used across routing.test.ts; the consumer call sites read `c.msg.startsWith
// (...)` etc., so preserving the name keeps the extraction mechanical.
// ---------------------------------------------------------------------------

/**
 * Captured notify call: the message and severity passed to `ui.notify`.
 */
export interface NotifyCall {
  msg: string;
  severity: string;
}

/**
 * Captured setStatus call: the line id and rendered content passed to
 * `ui.setStatus`.
 */
export interface SetStatusCall {
  id: string;
  content: string;
}

/**
 * Build a minimal fake UI that captures `notify` and `setStatus` calls into
 * arrays. The `theme.fg(severity, str)` method returns the string verbatim
 * (no ANSI) so assertions on captured content stay readable.
 *
 * Returns the `ui` stub plus the two capture arrays. Tests typically pass
 * `ui` into a fake `RunCtx` and assert against `notifyCalls` / `setStatusCalls`.
 */
export function makeFakeUI(): {
  // biome-ignore lint/suspicious/noExplicitAny: minimal ui stub
  ui: any;
  notifyCalls: NotifyCall[];
  setStatusCalls: SetStatusCall[];
} {
  const notifyCalls: NotifyCall[] = [];
  const setStatusCalls: SetStatusCall[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: minimal ui stub
  const ui: any = {
    theme: { fg: (_severity: string, str: string) => str },
    notify: (msg: string, severity: string) => {
      notifyCalls.push({ msg, severity });
    },
    setStatus: (id: string, content: string) => {
      setStatusCalls.push({ id, content });
    },
  };
  return { ui, notifyCalls, setStatusCalls };
}

/**
 * Spy-style ExtensionAPI that records `on(event, handler)` and
 * `registerCommand(name, opts)` calls. Other methods are no-ops since
 * extension `session_start` and command invocation don't use them.
 */
export interface CapturedExtensionAPI {
  // biome-ignore lint/suspicious/noExplicitAny: opaque event handlers by name
  handlers: Record<string, (event: any, ctx: any) => Promise<void> | void>;
  commands: Record<
    string,
    // biome-ignore lint/suspicious/noExplicitAny: opaque command handlers
    { handler: (args: string, ctx: any) => Promise<void> | void }
  >;
}

/**
 * Build a mock ExtensionAPI plus the capture object that records what the
 * extension registers when `distillExtension(api)` is called. Callers wire
 * the `api` into the extension and then drive the extension via
 * `captured.handlers.session_start(...)` or `captured.commands.distill?.handler(...)`.
 */
export function makeMockExtensionAPI(): {
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
