#!/usr/bin/env bun
/**
 * verify-e2e — full-runtime gate for the distill flow.
 *
 * This is the on-demand integration tier. It exercises BOTH halves of
 * the production code path end-to-end:
 *
 *   1. The session_start auto-init: `ensureVaultReadyForDistill(vault,
 *      "fast")` runs `git init`, installs the managed `.gitignore`
 *      block, and produces the initial commit.
 *   2. The manual `/distill` command handler triggers `runDistillWith`,
 *      which calls `ensureVaultReadyForDistill(vault, "full")` to
 *      enforce the full health-check matrix, then spawns the real
 *      wrapper subprocess via the worktree spawn function. The wrapper
 *      invokes `pi -p` against a real LLM, and the JS-side
 *      `setInterval` poller observes the wrapper's outcome sidecar and
 *      dispatches a UI notification through the captured fake UI.
 *
 * Fixture shape: mirrors the production user-onboarding flow rather
 * than pre-bootstrapping a healthy vault. The user has run
 * `napkin init` (which writes `.napkin/config.json` and any vault
 * content) and then launches `pi`; from there the extension's
 * session_start handler does the git init + scaffold + commit. The
 * fixture therefore writes ONLY the artefacts a real user genuinely
 * brings — `.napkin/config.json` and a content file — and lets the
 * production code do the rest. Fast-level health-check regressions
 * (auto-init failure, gitignore install regression, commit failure)
 * surface here; the previous fixture pre-bootstrapped git and could
 * not see them.
 *
 * Trade-off: gate wall time grows by the local git work auto-init
 * does (a few seconds at most); cost stays near $0.50/run because
 * the LLM-driven distill phase dominates.
 *
 * Strict superset of the prompt-only gate that this script replaces:
 * post-conditions cover the auto-init's filesystem effects AND the
 * wrapper's outcome class AND the JS-side notification severity AND
 * the bare-origin push (none of which the prompt-only harness could
 * validate).
 *
 * What this catches that a prompt-only harness can't:
 *
 *   - Auto-init regressions (git init failure, missing `.gitignore`
 *     managed block, missing initial commit, info notify silenced).
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
 *   2. Builds a vault that simulates the post-`napkin init` state:
 *      writes a sibling-layout `.napkin/config.json` (`vault.root:
 *      ".."`, `distill.enabled = true`) and a `note.md` content file.
 *      Does NOT run `git init`, does NOT scaffold `.gitignore`, does
 *      NOT commit — those are session_start's job.
 *   3. Builds a mock `ExtensionAPI` and calls `distillExtension(api)`
 *      so the production handlers and `/distill` command are
 *      registered against the captured spy.
 *   4. Triggers `captured.handlers.session_start({ reason: "new" },
 *      ctx)` — this fires `ensureVaultReadyForDistill(vault, "fast")`
 *      which performs `git init`, installs the managed gitignore
 *      block, runs `git add . && git commit`, and (via the index.ts
 *      handler) pushes an info notify announcing the init.
 *   5. Asserts the auto-init's filesystem + notify post-conditions:
 *      `.git/` exists, `.gitignore` contains the BEGIN/END markers and
 *      canonical block content, `.napkin/config.json` is tracked, HEAD
 *      points to a real commit, and the captured notify spy contains
 *      the canonical "Initialized git repo in your vault for
 *      auto-distill" info notification.
 *   6. THEN sets up the bare origin: `git init --bare origin/`,
 *      `git remote add origin <bare>`, `git push origin main`. Bare
 *      flag is mandatory: non-bare repos refuse pushes to checked-out
 *      branches, so the agent's push would fail and the outcome would
 *      be `merged-local` (warning) instead of `merged-content` (info),
 *      misclassifying the GREEN signature. This is the only piece of
 *      test scaffolding that is NOT user-flow — wrappers need a
 *      remote to push to.
 *   7. Allocates a SessionManager-managed session JSONL path under the
 *      tmpdir, then writes a synthetic 6-message conversation directly
 *      to that path via `writeSyntheticSession()`. The wrapper's
 *      session-fork step reads from disk via `getSessionFile()`, so as
 *      long as the synthetic content is on disk before the wrapper runs,
 *      ownership is unambiguous: SessionManager allocates the path,
 *      writeSyntheticSession writes the JSONL content, the wrapper
 *      reads it later.
 *   8. Triggers `captured.commands.distill?.handler("", ctx)`. This
 *      bypasses the 60-minute auto-distill interval — the manual
 *      handler invokes `runDistill(ctx)` immediately, which calls
 *      `ensureVaultReadyForDistill(vault, "full")` (full-level
 *      invariants on a healthy vault → no findings) and then
 *      `runDistillWith` to set up the real 2-second `setInterval`
 *      poll loop.
 *   9. Waits up to `distill.maxDurationMinutes * 60s + 30s` slack for the
 *      poll loop to fire its dispatch (`ctx.ui.notify` is captured into
 *      `notifyCalls`).
 *  10. Asserts on the dispatched notification + filesystem post-conditions:
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
 *        - auto-init notify present in `notifyCalls`
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
import {
  BLOCK_CONTENT,
  BLOCK_MARKER_BEGIN,
  BLOCK_MARKER_END,
} from "../extensions/distill/auto-setup";
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
  /**
   * SHA of the vault's default branch BEFORE the agent ran. Captured
   * AFTER `wireAutoInitOnVault` has installed `.git/` and produced the
   * initial commit, so this is the commit that the bare origin's
   * `main` ref will track at the start of the distill phase.
   */
  startSha: string;
  /** SHA of origin/main BEFORE the agent ran (post initial push). */
  originStartSha: string;
}

/**
 * Augment `process.env` with a fixed git identity + a global-config
 * override that disables gpg signing. Mirrors the pattern used by
 * `auto-setup.test.ts`'s `runSetup`: `ensureVaultReadyForDistill`
 * shells out to `git` with `env: process.env`, so identity vars must
 * be on `process.env` (not just on a per-spawn `env` map) for the
 * auto-init's `git commit` to succeed under a CI runner whose global
 * `commit.gpgsign=true` would otherwise refuse to commit unsigned.
 *
 * Returns a `restore` callback that reverts the mutations. Callers
 * MUST invoke it on the fail path AND the happy path — the env is
 * process-scoped state and leaving it dirty would affect any
 * subsequent code paths that introspect git identity.
 */
function installGitEnvOnProcess(): { restore: () => void } {
  const saved = {
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
    GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
    GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
    GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
  };
  process.env.GIT_AUTHOR_NAME = "verify";
  process.env.GIT_AUTHOR_EMAIL = "verify@example.com";
  process.env.GIT_COMMITTER_NAME = "verify";
  process.env.GIT_COMMITTER_EMAIL = "verify@example.com";
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "commit.gpgsign";
  process.env.GIT_CONFIG_VALUE_0 = "false";
  return {
    restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

/**
 * Build the on-disk shape that a real user brings to a fresh
 * `pi`-on-vault session: `.napkin/config.json` (sibling layout +
 * distill enabled) and a single `note.md` content file. Deliberately
 * does NOT run `git init` and does NOT commit — auto-init owns those
 * steps. Bare origin and remote wiring also live elsewhere because
 * they aren't part of `napkin init`'s footprint.
 *
 * Returns the partial fixture without `startSha` / `originStartSha`;
 * the caller fills those in after auto-init + bare-origin wiring.
 */
function setupFixture(): Omit<Fixture, "startSha" | "originStartSha"> {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-verify-e2e-"));
  const vaultPath = path.join(tmpdir, "vault");
  const originPath = path.join(tmpdir, "origin.git");
  const parentCwd = path.join(tmpdir, "parent");
  const sessionsDir = path.join(tmpdir, "sessions");

  fs.mkdirSync(vaultPath);
  fs.mkdirSync(parentCwd);
  fs.mkdirSync(sessionsDir);

  // `napkin init` produces `.napkin/config.json`; `vault.root: ".."`
  // marks the vault as sibling-layout so napkin resolves
  // contentPath=<vault>, and `distill.enabled=true` opts into the
  // worktree-backed path (instead of the legacy tmpdir spawn that
  // would bypass the wrapper).
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

  // User content present at the moment `pi` launches. Auto-init's
  // `git add .` will pick this up in the initial commit, mirroring
  // the production sequence where notes typically pre-exist the
  // first session_start.
  fs.writeFileSync(
    path.join(vaultPath, "note.md"),
    "---\ntitle: x\n---\n# baseline\n",
  );

  return {
    tmpdir,
    vaultPath,
    originPath,
    parentCwd,
    sessionsDir,
    defaultBranch: "main",
  };
}

/**
 * Wire the bare origin AFTER auto-init has produced `main`. Runs
 * `git init --bare origin/`, points the vault's `origin` remote at
 * it, and pushes `main` so the wrapper's later `git push origin
 * <branch>` has a parent commit to fast-forward from. Returns the
 * SHAs the gate uses as the "before-distill" reference.
 *
 * Bare flag is mandatory: a non-bare init refuses pushes to a
 * checked-out branch on modern git, steering the wrapper's outcome
 * to `merged-local` (warning) instead of `merged-content` (info) and
 * misclassifying the GREEN signature. This is the only piece of test
 * scaffolding that is not part of the user-onboarding flow — wrappers
 * need a remote.
 */
function wireBareOrigin(
  fixture: Omit<Fixture, "startSha" | "originStartSha">,
): { startSha: string; originStartSha: string } {
  const gitVault = (...args: string[]): string => {
    const r = spawnSync("git", ["-C", fixture.vaultPath, ...args], {
      encoding: "utf-8",
    });
    if (r.status !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed (rc=${r.status}): ${r.stderr.trim()}`,
      );
    }
    return r.stdout;
  };

  const originInit = spawnSync("git", ["init", "--bare", fixture.originPath]);
  if (originInit.status !== 0) {
    throw new Error(`git init --bare failed in ${fixture.originPath}`);
  }
  gitVault("remote", "add", "origin", fixture.originPath);
  gitVault("push", "origin", "main");

  const startSha = gitVault("rev-parse", "HEAD").trim();
  const originStartSha = spawnSync(
    "git",
    ["-C", fixture.originPath, "rev-parse", "main"],
    { encoding: "utf-8" },
  ).stdout.trim();

  return { startSha, originStartSha };
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

type BlockBodyExtraction =
  | { ok: true; lines: string[] }
  | { ok: false; reason: string };

/**
 * Extract the lines strictly BETWEEN `BLOCK_MARKER_BEGIN` and
 * `BLOCK_MARKER_END` in the given `.gitignore` content, normalised to
 * LF for line splitting (CRLF input round-trips byte-for-byte through
 * `mergeManagedBlock`, but the managed-body comparison is a content
 * check, not a line-ending check). Tolerates trailing whitespace on
 * marker lines (`mergeManagedBlock` does the same when reading) but
 * rejects indented markers — those aren't ours and shouldn't match.
 *
 * Returns `{ ok: true, lines }` with the body lines in document order,
 * or `{ ok: false, reason }` describing exactly which marker invariant
 * failed (missing, duplicated, mis-ordered).
 */
function extractManagedBlockBody(content: string): BlockBodyExtraction {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const beginIndices: number[] = [];
  const endIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const rtrimmed = lines[i].replace(/\s+$/, "");
    if (rtrimmed === BLOCK_MARKER_BEGIN) beginIndices.push(i);
    else if (rtrimmed === BLOCK_MARKER_END) endIndices.push(i);
  }
  if (beginIndices.length === 0)
    return { ok: false, reason: "BEGIN marker missing" };
  if (endIndices.length === 0)
    return { ok: false, reason: "END marker missing" };
  if (beginIndices.length > 1) {
    return {
      ok: false,
      reason: `${beginIndices.length} BEGIN markers (expected 1)`,
    };
  }
  if (endIndices.length > 1) {
    return {
      ok: false,
      reason: `${endIndices.length} END markers (expected 1)`,
    };
  }
  if (beginIndices[0] >= endIndices[0]) {
    return {
      ok: false,
      reason: `END marker (line ${endIndices[0] + 1}) precedes BEGIN marker (line ${beginIndices[0] + 1})`,
    };
  }
  return {
    ok: true,
    lines: lines.slice(beginIndices[0] + 1, endIndices[0]),
  };
}

/**
 * Render a useful diagnostic when a `.gitignore` managed block exists
 * but its body diverges from `BLOCK_CONTENT`. Reports the first
 * structural mismatch (length differs, line at index N differs) so a
 * fixture-format change that drops one line surfaces with the dropped
 * line in the gate output rather than "drift" alone.
 */
function describeBlockBodyDrift(actual: readonly string[]): string {
  if (actual.length !== BLOCK_CONTENT.length) {
    return `block body length=${actual.length}, expected ${BLOCK_CONTENT.length}`;
  }
  for (let i = 0; i < BLOCK_CONTENT.length; i++) {
    if (actual[i] !== BLOCK_CONTENT[i]) {
      return `block body line ${i + 1} differs: got ${JSON.stringify(actual[i])}, expected ${JSON.stringify(BLOCK_CONTENT[i])}`;
    }
  }
  // Defensive fallback: callers only reach this helper when the body
  // diverged, but a hypothetical equality bug shouldn't print empty.
  return "block body drift (no specific mismatch located)";
}

/**
 * Assert the filesystem effects of session_start's auto-init pass.
 * These are the cheap fast-level invariants that
 * `ensureVaultReadyForDistill(vault, "fast")` is contracted to leave
 * behind on a vault entering the gate without a `.git/`:
 *
 *   - `<vault>/.git/` exists (auto-init ran `git init -q -b main`).
 *   - `<vault>/.gitignore` contains the BEGIN/END managed-block markers
 *     and every line of the canonical `BLOCK_CONTENT` between them.
 *   - `.napkin/config.json` is tracked by git (auto-init's `git add .`
 *     respected the just-installed gitignore but still picked up the
 *     config file).
 *   - HEAD points to a real commit (auto-init produced "napkin: initial
 *     vault commit (auto-distill setup)").
 *
 * These are asserted BEFORE the bare-origin wiring + `/distill` trigger
 * so a regression in the auto-init path is reported as soon as it
 * fires — not after a 2-minute wait for the wrapper to do work that
 * was already doomed.
 */
function assertAutoInitPostConditions(
  vaultPath: string,
): PostConditionResult[] {
  const results: PostConditionResult[] = [];

  // .git/ presence — the bare-minimum invariant: auto-init refused to
  // run, ran but failed silently, or skipped the path on a vault it
  // misclassified as legacy-embedded.
  const gitDirExists = fs.existsSync(path.join(vaultPath, ".git"));
  results.push({
    name: "auto-init created <vault>/.git/",
    passed: gitDirExists,
    detail: gitDirExists
      ? "present"
      : "missing — auto-init's git init step did not run or failed silently",
  });

  // .gitignore managed block — extract the body BETWEEN the BEGIN/END
  // markers and compare ordered against `BLOCK_CONTENT`. A whole-file
  // substring check (`giContent.includes(line)`) is partly tautological
  // (the canonical content includes blank-line separators, and
  // `String.includes("")` is unconditionally true) AND not
  // locality-anchored (a regression that drops the markers but leaks
  // canonical lines into user territory would pass). Failing this
  // means `mergeManagedBlock` regressed (didn't install, misformatted
  // markers, dropped lines, reordered lines, or moved lines outside
  // the markers).
  const giPath = path.join(vaultPath, ".gitignore");
  const giExists = fs.existsSync(giPath);
  const giContent = giExists ? fs.readFileSync(giPath, "utf-8") : "";
  const giBlockBody = giExists
    ? extractManagedBlockBody(giContent)
    : { ok: false as const, reason: ".gitignore missing" };
  const giBlockMatches =
    giBlockBody.ok &&
    giBlockBody.lines.length === BLOCK_CONTENT.length &&
    giBlockBody.lines.every((l, i) => l === BLOCK_CONTENT[i]);
  results.push({
    name: "auto-init wrote .gitignore with the managed block + canonical content",
    passed: giExists && giBlockBody.ok && giBlockMatches,
    detail: !giExists
      ? ".gitignore missing"
      : !giBlockBody.ok
        ? giBlockBody.reason
        : giBlockMatches
          ? "markers + canonical body present (ordered match)"
          : describeBlockBodyDrift(giBlockBody.lines),
  });

  // .napkin/config.json tracked — the full-level invariant that
  // closes Issue #14 also has a fast-level shadow here: auto-init's
  // initial `git add .` pass should have staged config.json into the
  // first commit. If it didn't, the next `worktree add HEAD` won't
  // copy config.json into the worktree and napkin will fall back to
  // legacy-embedded layout.
  const lsConfig = spawnSync(
    "git",
    ["-C", vaultPath, "ls-files", "--error-unmatch", ".napkin/config.json"],
    { encoding: "utf-8" },
  );
  results.push({
    name: "auto-init's initial commit tracks .napkin/config.json",
    passed: lsConfig.status === 0,
    detail:
      lsConfig.status === 0
        ? "tracked"
        : `untracked (rc=${lsConfig.status}): ${lsConfig.stderr.trim()}`,
  });

  // HEAD resolves to a real commit. `rev-parse --verify HEAD` exits
  // non-zero on a commit-less repo (the failure mode that motivates
  // the seed-empty-commit branch in `ensureVaultReadyForDistill`).
  const headProbe = spawnSync(
    "git",
    ["-C", vaultPath, "rev-parse", "--verify", "HEAD"],
    { encoding: "utf-8" },
  );
  const headSha = headProbe.stdout.trim();
  results.push({
    name: "auto-init produced an initial commit (HEAD resolves)",
    passed: headProbe.status === 0 && headSha.length === 40,
    detail:
      headProbe.status === 0
        ? `HEAD=${headSha.slice(0, 12)}`
        : `rev-parse failed (rc=${headProbe.status}): ${headProbe.stderr.trim()}`,
  });

  return results;
}

function assertGreenPostConditions(
  fixture: Fixture,
  notify: NotifyCall | null,
  notifyCalls: readonly NotifyCall[],
): PostConditionResult[] {
  const results: PostConditionResult[] = [];

  // (auto-init) Captured notify spy includes the canonical first-run
  // notification dispatched by session_start once auto-init lands a
  // fresh `git init` + initial commit. The exact wording lives in
  // `extensions/distill/index.ts` (look for "Initialized git repo in
  // your vault for auto-distill"); pin the prefix here so a copy
  // change in the handler surfaces as a gate failure rather than a
  // silent loss of the user-visible signal. Severity must be `info`:
  // an `error` notify here means the auto-init's fail-soft branch
  // fired instead of the success branch.
  const autoInitNotify = notifyCalls.find((n) =>
    n.msg.startsWith("Initialized git repo in your vault for auto-distill"),
  );
  results.push({
    name: "session_start emitted the auto-init success notify",
    passed:
      !!autoInitNotify &&
      autoInitNotify.severity === "info" &&
      autoInitNotify.msg.includes(
        "napkin: initial vault commit (auto-distill setup)",
      ),
    detail: autoInitNotify
      ? `severity=${autoInitNotify.severity}, msg.startsWith("Initialized git repo...")`
      : `not present in ${notifyCalls.length} captured notify call(s)`,
  });

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
  console.log(
    "Setting up fixture (post-`napkin init` shape: .napkin/config.json + content; no .git/)...",
  );
  const startMs = Date.now();

  // Install the git identity + signing override on `process.env`
  // BEFORE any subprocess that spawns git — `ensureVaultReadyForDistill`
  // shells out via `runGit` with `env: process.env`, so identity must
  // live there for auto-init's `git commit` to succeed under a CI
  // runner whose global `commit.gpgsign=true` would otherwise refuse
  // to commit unsigned. Restore on every exit path below.
  const gitEnv = installGitEnvOnProcess();

  let fixturePartial: Omit<Fixture, "startSha" | "originStartSha">;
  try {
    fixturePartial = setupFixture();
  } catch (e) {
    gitEnv.restore();
    console.error(`error: fixture setup failed: ${(e as Error).message}`);
    return 2;
  }

  console.log(`  tmpdir:  ${fixturePartial.tmpdir}`);
  console.log(`  vault:   ${fixturePartial.vaultPath}`);
  console.log(`  origin:  ${fixturePartial.originPath}`);
  console.log("");

  // Wire the extension BEFORE driving the auto-init: distillExtension
  // registers handlers + the /distill command against the captured
  // spy. Tighter ordering than the previous fixture (which built the
  // mock API only at the /distill trigger): the auto-init now runs
  // through `captured.handlers.session_start`, which has to exist
  // before we fire it.
  const { api, captured } = makeMockExtensionAPI();
  // biome-ignore lint/suspicious/noExplicitAny: opaque ExtensionAPI shape
  distillExtension(api as any);
  if (!captured.handlers.session_start) {
    gitEnv.restore();
    if (!args.keepTmpdir) {
      fs.rmSync(fixturePartial.tmpdir, { recursive: true, force: true });
    }
    console.error("error: session_start handler not registered by extension");
    return 2;
  }
  if (!captured.commands.distill) {
    gitEnv.restore();
    if (!args.keepTmpdir) {
      fs.rmSync(fixturePartial.tmpdir, { recursive: true, force: true });
    }
    console.error("error: /distill command not registered by extension");
    return 2;
  }

  // Allow the wrapper subprocess to inherit the model selection.
  process.env.NAPKIN_DISTILL_MODEL = model;

  // Allocate session via SessionManager (path allocation only) and
  // overwrite via writeSyntheticSession (raw JSONL content). Order is
  // unambiguous: SessionManager owns the path, writeSyntheticSession
  // owns the content, the wrapper subprocess later reads from disk.
  const sm = SessionManager.create(
    fixturePartial.parentCwd,
    fixturePartial.sessionsDir,
  );
  const sessionFile = sm.getSessionFile();
  if (!sessionFile) {
    gitEnv.restore();
    if (!args.keepTmpdir) {
      fs.rmSync(fixturePartial.tmpdir, { recursive: true, force: true });
    }
    console.error("error: SessionManager allocated no session file");
    return 2;
  }
  writeSyntheticSession(sessionFile, fixturePartial.vaultPath);

  const { ui, notifyCalls } = makeFakeUI();
  // biome-ignore lint/suspicious/noExplicitAny: minimal RunCtx
  const ctx: any = {
    cwd: fixturePartial.vaultPath,
    sessionManager: sm,
    hasUI: true,
    ui,
  };

  // ----- Phase 1: drive auto-init through session_start ----------------------
  //
  // Mirrors production: a fresh `pi` invocation in a vault that has
  // `.napkin/config.json` but no `.git/`. session_start calls
  // `ensureVaultReadyForDistill(vault, "fast")` which performs
  // `git init -q -b main`, installs the managed gitignore block,
  // runs `git add . && git commit`, and (via the index.ts handler)
  // pushes an info notify announcing the init.
  console.log("Triggering session_start (auto-init phase)...");
  const autoInitStart = Date.now();
  await captured.handlers.session_start({ reason: "new" }, ctx);
  const autoInitWallMs = Date.now() - autoInitStart;
  console.log(
    `  auto-init wall: ${(autoInitWallMs / 1000).toFixed(2)}s ` +
      `(notify spy captured ${notifyCalls.length} call(s))`,
  );

  const autoInitResults = assertAutoInitPostConditions(
    fixturePartial.vaultPath,
  );
  const autoInitAllPassed = autoInitResults.every((r) => r.passed);
  if (!autoInitAllPassed) {
    // Auto-init regressed — fail fast instead of waiting on a wrapper
    // run that's now guaranteed to misbehave.
    console.log("");
    console.log("Auto-init phase failed; skipping /distill trigger.");
    for (const r of autoInitResults) {
      console.log(`  ${r.passed ? "✓" : "✗"} ${r.name}`);
      if (!r.passed) console.log(`      ${r.detail}`);
    }
    gitEnv.restore();
    if (!args.keepTmpdir) {
      fs.rmSync(fixturePartial.tmpdir, { recursive: true, force: true });
    } else {
      console.log(
        `  --keep-tmpdir: leaving ${fixturePartial.tmpdir} for inspection.`,
      );
    }
    return 1;
  }

  // ----- Phase 2: bare origin (test scaffolding only) ------------------------
  //
  // Auto-init produced `main` with the initial commit; now we wire a
  // bare origin so the wrapper's `git push origin <branch>` later has
  // a parent commit to fast-forward from. This is the only piece of
  // setup that is NOT user-flow — wrappers need a remote.
  let originRefs: { startSha: string; originStartSha: string };
  try {
    originRefs = wireBareOrigin(fixturePartial);
  } catch (e) {
    gitEnv.restore();
    if (!args.keepTmpdir) {
      fs.rmSync(fixturePartial.tmpdir, { recursive: true, force: true });
    }
    console.error(`error: bare-origin wiring failed: ${(e as Error).message}`);
    return 2;
  }
  const fixture: Fixture = { ...fixturePartial, ...originRefs };

  // ----- Phase 3: drive /distill -------------------------------------------
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

  // Combined post-conditions: auto-init's filesystem invariants + the
  // distill phase's notify / outcome / filesystem invariants. The
  // auto-init block is re-run here so the summary contains every
  // checked invariant in one place — a single PASS/FAIL decision.
  const results = [
    ...autoInitResults,
    ...assertGreenPostConditions(fixture, notify, notifyCalls),
  ];
  const passed = printSummary(
    results,
    notify,
    outcome,
    gate,
    fixture,
    model,
    startMs,
  );

  gitEnv.restore();
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
