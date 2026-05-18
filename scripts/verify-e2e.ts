#!/usr/bin/env bun
/**
 * verify-e2e — full-runtime gate for the distill flow.
 *
 * This is the on-demand integration tier. It exercises the production
 * code path end-to-end: the manual `/distill` command handler triggers
 * `runDistillWith`, which spawns the real wrapper subprocess (via the
 * worktree spawn function), the wrapper invokes `pi -p` against a real
 * LLM, and the JS-side `setInterval` poller observes the wrapper's
 * outcome sidecar and dispatches a UI notification through the captured
 * fake UI. The script then asserts on the dispatched notification's
 * severity + message plus filesystem post-conditions.
 *
 * Strict superset of the prompt-only gate that this script replaces:
 * post-conditions cover the wrapper's outcome class AND the JS-side
 * notification severity AND the bare-origin push (which the prompt-only
 * harness couldn't validate).
 *
 * What this catches that a prompt-only harness can't:
 *
 *   - Races between the wrapper's worktree teardown and its outcome
 *     write (the JS poller can observe worktree-gone with no outcome
 *     yet, dispatching the wrong notification).
 *   - Wrapper post-validation failures (markers leaked, commit count
 *     wrong, local-only push paths).
 *   - JS poller dispatch correctness on the wrapper's actual sidecar
 *     content.
 *
 * What it does:
 *
 *   1. Creates a tmpdir at `${TMPDIR:-/tmp}/napkin-verify-e2e-XXXXXX`.
 *   2. `git init -b main` a vault. Writes a sibling-layout `.napkin/config.json`
 *      with `vault.root: ".."` and `distill.enabled = true` so napkin
 *      resolves `contentPath=<vault>` and `runDistill` routes through
 *      the worktree spawn path (NOT the legacy-embedded fallback).
 *   3. `git init --bare` a sibling origin and `git push origin main` so
 *      the wrapper's push step has somewhere to land. The bare flag is
 *      mandatory: non-bare repos refuse pushes to checked-out branches,
 *      so the agent's push would fail and the outcome would be
 *      `merged-local` (warning) instead of `merged-content` (info),
 *      misclassifying the GREEN signature.
 *   4. Allocates a SessionManager-managed session JSONL path under the
 *      tmpdir, then writes a synthetic 6-message conversation directly
 *      to that path via `writeSyntheticSession()`. The wrapper's
 *      session-fork step reads from disk via `getSessionFile()`, so as
 *      long as the synthetic content is on disk before the wrapper runs,
 *      ownership is unambiguous: SessionManager allocates the path,
 *      writeSyntheticSession writes the JSONL content, the wrapper
 *      reads it later.
 *   5. Builds a mock `ExtensionAPI` and calls `distillExtension(api)` so
 *      the production handlers and `/distill` command are registered
 *      against the captured spy.
 *   6. Constructs a fake `RunCtx` (cwd=vault, sessionManager, fake UI)
 *      and triggers `captured.commands.distill?.handler("", ctx)`. This
 *      bypasses the 60-minute auto-distill interval — the manual
 *      handler invokes `runDistill(ctx)` immediately, which calls
 *      `runDistillWith` and sets up the real 2-second `setInterval`
 *      poll loop.
 *   7. Waits up to `distill.maxDurationMinutes * 60s + 30s` slack for the
 *      poll loop to fire its dispatch (`ctx.ui.notify` is captured into
 *      `notifyCalls`).
 *   8. Asserts on the dispatched notification + filesystem post-conditions:
 *
 *      RED-gate FAIL signature (current buggy code; what we expect
 *      against the unfixed branch):
 *        - severity === "warning"
 *        - msg matches /terminated abnormally/i
 *        - (eventually) outcome sidecar exists with class merged-content
 *
 *      GREEN-gate PASS signature (post-fix; what we expect after the
 *      race is closed):
 *        - severity === "info"
 *        - msg.startsWith("Distillation complete (")  // trailing `(`
 *          disambiguates merged-content from merged-local's
 *          "Distillation complete locally; not pushed to origin (Ns)"
 *        - all filesystem post-conditions green (no markers, default
 *          branch, squash committed, branch removed, worktree removed,
 *          outcome class merged-content, origin advanced)
 *
 * Production code never runs this. Lives outside `extensions/` to avoid
 * being mistaken for a runtime asset.
 *
 * Caveats:
 *   - LLM-side variance: a single failure run is NOT a definitive
 *     verdict — instruction-following has known multi-run variance.
 *   - Cost: a single run is ~$0.50 of token-equivalent on Anthropic API
 *     pricing. Kiro provider reports $0 (seat-billed).
 *   - Single-run policy: no `--runs N` flake-management. The natural
 *     test must reliably reproduce the race on buggy code.
 *   - Fixture iteration budget: if the RED gate's first run PASSES
 *     against unfixed code (test didn't catch the race), the fixture is
 *     insufficient. Iterate the synthetic conversation up to 5 attempts
 *     (~$2.50). After that, escalate.
 *
 * Usage:
 *   bun run verify:e2e
 *   bun run verify:e2e -- --model kiro/claude-sonnet-4-6
 *   bun run verify:e2e -- --keep-tmpdir
 *   bun run verify:e2e -- --help
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import distillExtension from "../extensions/distill";
import {
  makeFakeUI,
  makeMockExtensionAPI,
  type NotifyCall,
} from "../extensions/distill/_test-helpers";
import { writeSyntheticSession } from "./_e2e-helpers";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "kiro/claude-sonnet-4-6";

/** Vault-config `distill.maxDurationMinutes`. */
const DISTILL_MAX_DURATION_MINUTES = 10;

/** Slack added to maxDurationMinutes when waiting for the JS poller dispatch. */
const POLLER_DISPATCH_SLACK_SECS = 30;

/** Polling interval for the assertion-side wait loop. */
const ASSERTION_POLL_INTERVAL_MS = 250;

interface Args {
  model: string;
  keepTmpdir: boolean;
  help: boolean;
}

const HELP = `verify-e2e — full-runtime gate for the distill flow

Usage: bun run verify:e2e [-- <flags>]

Flags:
  --model <provider>/<id>   Model to invoke (default: ${DEFAULT_MODEL}, or
                            read from ~/.config/napkin/config.json's vault
                            if set there).
  --keep-tmpdir             Don't rm the tmpdir on exit (forensic).
  --help, -h                Print this and exit 0.

Notes:
  - Single-run policy: no --runs N. The natural test must reliably
    reproduce the race on buggy code; if it doesn't, iterate the
    synthetic fixture or escalate.
  - Cost: ~$0.50 per run at Anthropic API rates. Kiro provider bills via
    seat (reports $0).
  - Fixture iteration budget: if a RED-gate run passes against unfixed
    code, iterate the synthetic conversation up to 5 attempts (~$2.50).
    After that, escalate.

Exit codes:
  0  — Notification + filesystem post-conditions match GREEN signature.
  1  — One or more post-conditions failed; see printed summary.
  2  — Setup error (mktemp failed, pi binary missing, etc.).
`;

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { model: "", keepTmpdir: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--keep-tmpdir") args.keepTmpdir = true;
    else if (a === "--model") {
      const next = argv[i + 1];
      if (!next) throw new Error("--model requires a value");
      args.model = next;
      i++;
    } else if (a.startsWith("--model=")) {
      args.model = a.slice("--model=".length);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return args;
}

/**
 * Resolve the model. Priority:
 *   1. Explicit --model flag.
 *   2. Vault `distill.model.{provider,id}` from
 *      `<global-config-vault>/.napkin/config.json`.
 *   3. {@link DEFAULT_MODEL}.
 */
function resolveModel(explicit: string): string {
  if (explicit) return explicit;
  try {
    const xdg =
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    const globalCfg = JSON.parse(
      fs.readFileSync(path.join(xdg, "napkin", "config.json"), "utf-8"),
    );
    let vault = globalCfg?.vault;
    if (typeof vault !== "string") return DEFAULT_MODEL;
    if (vault.startsWith("~/")) vault = path.join(os.homedir(), vault.slice(2));
    const vaultCfgPath = path.join(vault, ".napkin", "config.json");
    if (!fs.existsSync(vaultCfgPath)) return DEFAULT_MODEL;
    const vaultCfg = JSON.parse(fs.readFileSync(vaultCfgPath, "utf-8"));
    const provider = vaultCfg?.distill?.model?.provider;
    const id = vaultCfg?.distill?.model?.id;
    if (typeof provider === "string" && typeof id === "string") {
      return `${provider}/${id}`;
    }
  } catch {
    // Any read/parse error → fall through to default.
  }
  return DEFAULT_MODEL;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Fixture {
  tmpdir: string;
  vaultPath: string;
  originPath: string;
  parentCwd: string;
  sessionsDir: string;
  defaultBranch: string;
  /** SHA of the vault's default branch BEFORE the agent ran. */
  startSha: string;
  /** SHA of origin/main BEFORE the agent ran (post initial push). */
  originStartSha: string;
}

function setupFixture(): Fixture {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-verify-e2e-"));
  const vaultPath = path.join(tmpdir, "vault");
  const originPath = path.join(tmpdir, "origin.git");
  const parentCwd = path.join(tmpdir, "parent");
  const sessionsDir = path.join(tmpdir, "sessions");

  fs.mkdirSync(vaultPath);
  fs.mkdirSync(parentCwd);
  fs.mkdirSync(sessionsDir);

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "verify",
    GIT_AUTHOR_EMAIL: "verify@example.com",
    GIT_COMMITTER_NAME: "verify",
    GIT_COMMITTER_EMAIL: "verify@example.com",
  };
  const gitVault = (...args: string[]): string => {
    const r = spawnSync("git", ["-C", vaultPath, ...args], {
      env,
      encoding: "utf-8",
    });
    if (r.status !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed (rc=${r.status}): ${r.stderr.trim()}`,
      );
    }
    return r.stdout;
  };

  // Vault: default branch `main`, ephemeral identity, signing off.
  const initRc = spawnSync("git", ["init", "-b", "main", vaultPath], { env });
  if (initRc.status !== 0) {
    throw new Error(`git init failed in ${vaultPath}`);
  }
  gitVault("config", "user.email", "verify@example.com");
  gitVault("config", "user.name", "verify");
  gitVault("config", "commit.gpgsign", "false");

  // Sibling-layout config: `vault.root: ".."` (so napkin resolves
  // contentPath=<vault>) AND `distill.enabled=true` (so runDistill
  // routes through worktreeSpawnFn rather than legacySpawnFn). Both
  // keys are required for the production worktree-backed code path
  // to fire — without `vault.root`, the vault is treated as
  // legacy-embedded and bypasses the wrapper entirely.
  fs.mkdirSync(path.join(vaultPath, ".napkin"), { recursive: true });
  fs.writeFileSync(
    path.join(vaultPath, ".napkin", "config.json"),
    JSON.stringify({
      vault: { root: ".." },
      distill: {
        enabled: true,
        intervalMinutes: 60,
        maxDurationMinutes: DISTILL_MAX_DURATION_MINUTES,
        onShutdown: false,
      },
    }),
  );

  fs.writeFileSync(
    path.join(vaultPath, "note.md"),
    "---\ntitle: x\n---\n# baseline\n",
  );
  gitVault("add", "-A");
  gitVault("commit", "-m", "verify: baseline");

  // Bare origin so the wrapper's push lands without needing
  // `receive.denyCurrentBranch=ignore`. A non-bare init refuses pushes
  // to a checked-out branch on modern git, which would steer the
  // outcome to `merged-local` (warning) instead of `merged-content`
  // (info) and misclassify the GREEN signature.
  const originInit = spawnSync("git", ["init", "--bare", originPath], { env });
  if (originInit.status !== 0) {
    throw new Error(`git init --bare failed in ${originPath}`);
  }
  gitVault("remote", "add", "origin", originPath);
  gitVault("push", "origin", "main");

  const startSha = gitVault("rev-parse", "HEAD").trim();
  const originStartSha = spawnSync(
    "git",
    ["-C", originPath, "rev-parse", "main"],
    { env, encoding: "utf-8" },
  ).stdout.trim();

  return {
    tmpdir,
    vaultPath,
    originPath,
    parentCwd,
    sessionsDir,
    defaultBranch: "main",
    startSha,
    originStartSha,
  };
}

// ---------------------------------------------------------------------------
// Trigger + wait
// ---------------------------------------------------------------------------

/**
 * Wait up to `timeoutMs` for `notifyCalls` to acquire any non-status
 * notification matching either the RED or GREEN signature shape.
 *
 * Returns the matched call, or null on timeout.
 */
async function waitForOutcomeNotify(
  notifyCalls: NotifyCall[],
  timeoutMs: number,
): Promise<NotifyCall | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const match = notifyCalls.find((c) => isOutcomeNotify(c));
    if (match) return match;
    await new Promise((r) => setTimeout(r, ASSERTION_POLL_INTERVAL_MS));
  }
  return null;
}

/**
 * Predicate for "this is the wrapper-outcome dispatch" — distinguishes
 * the terminal notify from spurious "Distill already running" warnings
 * or other transient messages. Matches the verbiage in
 * `formatOutcomeNotification` (extensions/distill/index.ts).
 */
function isOutcomeNotify(c: NotifyCall): boolean {
  if (c.msg.startsWith("Distillation complete")) return true;
  if (c.msg.startsWith("Distillation ran but saved no content")) return true;
  if (c.msg.startsWith("Distillation failed")) return true;
  if (c.msg.startsWith("Distillation timed out")) return true;
  if (c.msg.match(/terminated abnormally/i)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Post-conditions
// ---------------------------------------------------------------------------

interface PostConditionResult {
  name: string;
  passed: boolean;
  detail: string;
}

interface OutcomeSidecar {
  outcomeClass: string;
  recoveryHint: string;
  path: string;
}

/**
 * Locate the outcome sidecar under `<vault>/.napkin/distill/errors/`.
 * Returns null if no `*.outcome` file is present. Multi-line sidecars
 * collapse to line 1 (the canonical class string).
 */
function readOutcomeSidecar(vaultPath: string): OutcomeSidecar | null {
  const errorDir = path.join(vaultPath, ".napkin", "distill", "errors");
  if (!fs.existsSync(errorDir)) return null;
  const outcomeFiles = fs
    .readdirSync(errorDir)
    .filter((f) => f.endsWith(".outcome"));
  if (outcomeFiles.length === 0) return null;
  // Pick the most recently mtime'd outcome file.
  const sorted = outcomeFiles
    .map((f) => {
      const p = path.join(errorDir, f);
      return { p, mtime: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  const target = sorted[0].p;
  const raw = fs.readFileSync(target, "utf-8");
  const [first, ...rest] = raw.split("\n");
  return {
    outcomeClass: (first ?? "").trim(),
    recoveryHint: rest.join("\n").trim(),
    path: target,
  };
}

function assertGreenPostConditions(
  fixture: Fixture,
  notify: NotifyCall | null,
): PostConditionResult[] {
  const results: PostConditionResult[] = [];

  // (1) Notification severity + message.
  if (!notify) {
    results.push({
      name: "JS poller dispatched a notification",
      passed: false,
      detail: "no outcome notification observed within timeout",
    });
  } else {
    results.push({
      name: 'notification severity === "info"',
      passed: notify.severity === "info",
      detail: `severity=${notify.severity}, msg=${JSON.stringify(notify.msg)}`,
    });
    results.push({
      name: 'notification msg.startsWith("Distillation complete (")',
      passed: notify.msg.startsWith("Distillation complete ("),
      detail: `msg=${JSON.stringify(notify.msg)}`,
    });
  }

  // (2) No conflict markers.
  const grep = spawnSync(
    "grep",
    ["-rEnH", "^<{7} |^={7}$|^>{7} ", "--include=*.md", fixture.vaultPath],
    { encoding: "utf-8" },
  );
  results.push({
    name: "no conflict markers in *.md",
    passed: grep.status === 1,
    detail:
      grep.status === 1
        ? "no markers"
        : grep.status === 0
          ? `markers found:\n${grep.stdout.trim()}`
          : `grep failed (rc=${grep.status}): ${grep.stderr.trim()}`,
  });

  // (3) Vault HEAD on default branch.
  const headRef = spawnSync(
    "git",
    ["-C", fixture.vaultPath, "symbolic-ref", "--short", "HEAD"],
    { encoding: "utf-8" },
  );
  const head = headRef.stdout.trim();
  results.push({
    name: `vault HEAD on ${fixture.defaultBranch}`,
    passed: headRef.status === 0 && head === fixture.defaultBranch,
    detail:
      headRef.status === 0
        ? `HEAD on '${head}'`
        : `symbolic-ref failed: ${headRef.stderr.trim()}`,
  });

  // (4) Squash commit landed on default — count >= 2 (1 baseline + agent).
  const commitCount = spawnSync(
    "git",
    [
      "-C",
      fixture.vaultPath,
      "rev-list",
      "--count",
      `${fixture.startSha}..HEAD`,
    ],
    { encoding: "utf-8" },
  );
  const count = Number.parseInt(commitCount.stdout.trim(), 10);
  results.push({
    name: "agent's squash commit landed on default",
    passed: Number.isFinite(count) && count >= 1,
    detail: Number.isFinite(count)
      ? `${count} commits since startSha`
      : `rev-list failed: ${commitCount.stderr.trim()}`,
  });

  // (5) Distill branches removed (no `distill/*` left in vault).
  const branchList = spawnSync(
    "git",
    ["-C", fixture.vaultPath, "branch", "--list", "distill/*"],
    { encoding: "utf-8" },
  );
  results.push({
    name: "all distill/* branches removed",
    passed: branchList.stdout.trim() === "",
    detail:
      branchList.stdout.trim() === ""
        ? "removed"
        : `still present: ${branchList.stdout.trim()}`,
  });

  // (6) Worktrees pruned.
  const worktreeList = spawnSync(
    "git",
    ["-C", fixture.vaultPath, "worktree", "list", "--porcelain"],
    { encoding: "utf-8" },
  );
  const distillWorktreesStillTracked = worktreeList.stdout
    .split("\n")
    .filter(
      (l) => l.startsWith("worktree ") && l.includes(".napkin/distill"),
    ).length;
  results.push({
    name: "distill worktrees removed",
    passed: distillWorktreesStillTracked === 0,
    detail:
      distillWorktreesStillTracked === 0
        ? "no distill worktrees tracked"
        : `${distillWorktreesStillTracked} worktree(s) still tracked`,
  });

  // (7) Outcome sidecar exists with class merged-content.
  const outcome = readOutcomeSidecar(fixture.vaultPath);
  results.push({
    name: 'outcome sidecar class === "merged-content"',
    passed: outcome?.outcomeClass === "merged-content",
    detail: outcome
      ? `class=${outcome.outcomeClass} (path=${outcome.path})`
      : "no outcome sidecar found under .napkin/distill/errors/",
  });

  // (8) Origin advanced (push happened).
  const originHead = spawnSync(
    "git",
    ["-C", fixture.originPath, "rev-parse", "main"],
    { encoding: "utf-8" },
  );
  const originHeadSha = originHead.stdout.trim();
  results.push({
    name: "origin/main advanced (push landed)",
    passed: originHead.status === 0 && originHeadSha !== fixture.originStartSha,
    detail:
      originHead.status === 0
        ? originHeadSha === fixture.originStartSha
          ? `origin still at ${originHeadSha.slice(0, 12)} (no push)`
          : `origin advanced to ${originHeadSha.slice(0, 12)}`
        : `origin rev-parse failed: ${originHead.stderr.trim()}`,
  });

  return results;
}

/**
 * Decide the gate verdict from notify shape + outcome class.
 * - "green": notification is `info` + `Distillation complete (`; outcome class merged-content.
 * - "red":   notification is `warning` + `terminated abnormally`.
 * - "other": neither matches — gate is inconclusive (different bug).
 */
function classifyGate(
  notify: NotifyCall | null,
  outcome: OutcomeSidecar | null,
): "green" | "red" | "other" {
  if (!notify) return "other";
  if (
    notify.severity === "info" &&
    notify.msg.startsWith("Distillation complete (") &&
    outcome?.outcomeClass === "merged-content"
  ) {
    return "green";
  }
  if (
    notify.severity === "warning" &&
    /terminated abnormally/i.test(notify.msg)
  ) {
    return "red";
  }
  return "other";
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printSummary(
  results: PostConditionResult[],
  notify: NotifyCall | null,
  outcome: OutcomeSidecar | null,
  gate: "green" | "red" | "other",
  fixture: Fixture,
  model: string,
  startMs: number,
): boolean {
  const wallSecs = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log("");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`verify-e2e — model=${model}, wall=${wallSecs}s`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  fixture tmpdir: ${fixture.tmpdir}`);
  console.log(`  startSha: ${fixture.startSha.slice(0, 12)}`);
  console.log(
    `  notification: ${notify ? `severity=${notify.severity}, msg=${JSON.stringify(notify.msg)}` : "(none)"}`,
  );
  console.log(
    `  outcome:      ${outcome ? `class=${outcome.outcomeClass}` : "(none)"}`,
  );
  console.log(`  gate:         ${gate.toUpperCase()}`);
  console.log("");
  let allPassed = true;
  for (const r of results) {
    const mark = r.passed ? "✓" : "✗";
    if (!r.passed) allPassed = false;
    console.log(`  ${mark} ${r.name}`);
    if (!r.passed) console.log(`      ${r.detail}`);
  }
  console.log("");
  if (allPassed) {
    console.log(
      `  RESULT: PASS (${results.length}/${results.length} post-conditions)`,
    );
  } else {
    const failedCount = results.filter((r) => !r.passed).length;
    console.log(
      `  RESULT: FAIL (${failedCount}/${results.length} post-conditions failed)`,
    );
  }
  console.log("");
  return allPassed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${(e as Error).message}\n`);
    console.error(HELP);
    return 2;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const model = resolveModel(args.model);

  // Sanity: pi binary must exist (the wrapper calls it internally).
  const piCheck = spawnSync(
    process.env.NAPKIN_DISTILL_PI_BIN || "pi",
    ["--version"],
    { encoding: "utf-8" },
  );
  if (piCheck.error) {
    console.error(
      `error: pi binary not found on PATH (NAPKIN_DISTILL_PI_BIN unset). Install pi or set the env var.`,
    );
    return 2;
  }

  console.log(`verify-e2e: model=${model}`);
  console.log("Setting up fixture...");
  const startMs = Date.now();
  let fixture: Fixture;
  try {
    fixture = setupFixture();
  } catch (e) {
    console.error(`error: fixture setup failed: ${(e as Error).message}`);
    return 2;
  }

  console.log(`  tmpdir:  ${fixture.tmpdir}`);
  console.log(`  vault:   ${fixture.vaultPath}`);
  console.log(`  origin:  ${fixture.originPath}`);
  console.log("");

  // Allocate session via SessionManager (path allocation only) and
  // overwrite via writeSyntheticSession (raw JSONL content). Order is
  // unambiguous: SessionManager owns the path, writeSyntheticSession
  // owns the content, the wrapper subprocess later reads from disk.
  const sm = SessionManager.create(fixture.parentCwd, fixture.sessionsDir);
  const sessionFile = sm.getSessionFile();
  if (!sessionFile) {
    console.error("error: SessionManager allocated no session file");
    if (!args.keepTmpdir) {
      fs.rmSync(fixture.tmpdir, { recursive: true, force: true });
    }
    return 2;
  }
  writeSyntheticSession(sessionFile, fixture.vaultPath);

  // Wire the extension. distillExtension(api) registers handlers + the
  // /distill command against the captured spy.
  const { api, captured } = makeMockExtensionAPI();
  // biome-ignore lint/suspicious/noExplicitAny: opaque ExtensionAPI shape
  distillExtension(api as any);
  if (!captured.commands.distill) {
    console.error("error: /distill command not registered by extension");
    if (!args.keepTmpdir) {
      fs.rmSync(fixture.tmpdir, { recursive: true, force: true });
    }
    return 2;
  }

  // Allow the wrapper subprocess to inherit the model selection.
  process.env.NAPKIN_DISTILL_MODEL = model;

  const { ui, notifyCalls } = makeFakeUI();
  // biome-ignore lint/suspicious/noExplicitAny: minimal RunCtx
  const ctx: any = {
    cwd: fixture.vaultPath,
    sessionManager: sm,
    hasUI: true,
    ui,
  };

  const triggerStart = Date.now();
  console.log(
    `Triggering /distill (timeout ${DISTILL_MAX_DURATION_MINUTES}m + ${POLLER_DISPATCH_SLACK_SECS}s slack)...`,
  );
  await captured.commands.distill.handler("", ctx);

  // Wait for the JS poller to fire its dispatch.
  const timeoutMs =
    DISTILL_MAX_DURATION_MINUTES * 60 * 1000 +
    POLLER_DISPATCH_SLACK_SECS * 1000;
  const notify = await waitForOutcomeNotify(notifyCalls, timeoutMs);
  const triggerWallMs = Date.now() - triggerStart;
  console.log(
    `Notify dispatch wall: ${(triggerWallMs / 1000).toFixed(1)}s (poll loop tick is 2s)`,
  );

  // Read the outcome sidecar (filesystem evidence — independent of the
  // notification dispatch path).
  const outcome = readOutcomeSidecar(fixture.vaultPath);
  const gate = classifyGate(notify, outcome);

  const results = assertGreenPostConditions(fixture, notify);
  const passed = printSummary(
    results,
    notify,
    outcome,
    gate,
    fixture,
    model,
    startMs,
  );

  if (args.keepTmpdir) {
    console.log(`  --keep-tmpdir: leaving ${fixture.tmpdir} for inspection.`);
  } else {
    fs.rmSync(fixture.tmpdir, { recursive: true, force: true });
  }

  return passed ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`fatal: ${(e as Error).stack ?? e}`);
    process.exit(2);
  });
