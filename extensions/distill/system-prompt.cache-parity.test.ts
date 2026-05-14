/**
 * POST-R6-CACHE / R7-PERF-1 — system-prompt cache-parity test.
 *
 * The whole point of POST-R6-CACHE is to keep the distill subprocess's
 * system prompt byte-identical to the parent's cached prefix, so
 * Anthropic's prompt-cache hits across the fork boundary instead of
 * re-encoding the entire conversation history (~$0.50–$1/distill on
 * long sessions).
 *
 * `2d5583f` made `forkFrom` write `parentCwd` into the session-fork
 * header (instead of the worktree path) and made the wrapper spawn pi
 * at `parentCwd`. That fix relies on a single invariant: when pi
 * subsequently calls `buildSystemPrompt` with the cwd from the fork
 * header, the resulting prompt is byte-identical to what the parent
 * already cached.
 *
 * Round-7 reviewer (R7-PERF-1) flagged that the existing tests assert
 * the proxy ("fork header has correct cwd") but never the actual
 * invariant ("system prompt is byte-identical"). This test closes the
 * gap by importing pi's real `buildSystemPrompt` and comparing the
 * outputs directly.
 *
 * Three assertions:
 *   1. Two builds with `cwd: parentCwd` produce byte-identical prompts
 *      (same cwd → same prompt; this is the parent⇄distill match).
 *   2. A build with `cwd: worktreePath` differs from `cwd: parentCwd`
 *      (control: proves the cwd parameter actually affects the output,
 *      so assertion #1 is meaningful and not a tautology).
 *   3. The diff between #1 and #2 is exactly the `Current working
 *      directory:` line — no other surprise drift from the cwd change.
 *
 * Plus a version-pin: the test verifies pi still exposes
 * `buildSystemPrompt` at the expected path. Mirrors the
 * `session-touched-files.version-check.test.ts` pattern.
 *
 * If pi's `buildSystemPrompt` adds new cwd-dependent inputs (skills,
 * AGENTS.md walk-up, etc.), the byte-equality assertion is unaffected
 * (we use the same cwd for both builds in #1) but it's worth re-reading
 * the function source to confirm no new asymmetric branches.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PI_SYSTEM_PROMPT_PATH = path.join(
  __dirname,
  "..",
  "..",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "core",
  "system-prompt.js",
);

describe("pi system-prompt version pin (POST-R6-CACHE / R7-PERF-1)", () => {
  test("pi-coding-agent still exposes system-prompt.js at the expected path", () => {
    expect(fs.existsSync(PI_SYSTEM_PROMPT_PATH)).toBe(true);
  });

  test("system-prompt.js still defines `buildSystemPrompt`", () => {
    const src = fs.readFileSync(PI_SYSTEM_PROMPT_PATH, "utf-8");
    expect(src).toContain("buildSystemPrompt");
  });

  test("system-prompt.js still appends `Current working directory:` (cwd is the cache-parity invariant)", () => {
    const src = fs.readFileSync(PI_SYSTEM_PROMPT_PATH, "utf-8");
    // The whole POST-R6-CACHE fix hinges on this line being the only
    // cwd-derived content in the system prompt. If pi upstream changes
    // the wording or moves the cwd into a different position, the
    // byte-equality check below stays valid (same inputs → same output)
    // but we want a loud signal that the assumption needs re-reading.
    expect(src).toContain("Current working directory:");
  });
});

describe("system-prompt cache parity (POST-R6-CACHE / R7-PERF-1)", () => {
  // Build two cwd values that mirror the production setup: parentCwd is
  // pi's launch dir (parent vault), worktreePath is the per-distill
  // worktree under XDG cache. The wrapper spawns pi at parentCwd; pi
  // then builds the system prompt with cwd from the fork header.
  let parentCwd: string;
  let worktreePath: string;

  beforeEach(() => {
    parentCwd = fs.mkdtempSync(path.join(os.tmpdir(), "cache-parity-parent-"));
    worktreePath = fs.mkdtempSync(
      path.join(os.tmpdir(), "cache-parity-worktree-"),
    );
  });

  afterEach(() => {
    fs.rmSync(parentCwd, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  });

  test("two builds with cwd=parentCwd produce byte-identical system prompts (parent ⇄ distill match)", async () => {
    // Import pi's real buildSystemPrompt. The package's `exports` field
    // doesn't expose this entry point, so we import via the absolute
    // file path — same pattern works on Bun, Node, and the bundler.
    // The version-pin tests above confirm the file exists.
    const { buildSystemPrompt } = await import(PI_SYSTEM_PROMPT_PATH);

    // Same inputs except for nothing. Two independent calls, same cwd.
    // This is the prefix that has to match between parent and distill
    // for the cache to hit.
    const parentBuild = buildSystemPrompt({
      cwd: parentCwd,
      contextFiles: [],
      skills: [],
    });
    const distillBuild = buildSystemPrompt({
      cwd: parentCwd,
      contextFiles: [],
      skills: [],
    });

    expect(distillBuild).toBe(parentBuild);
  });

  test("control: build with cwd=worktreePath differs from cwd=parentCwd (proves cwd is load-bearing)", async () => {
    const { buildSystemPrompt } = await import(PI_SYSTEM_PROMPT_PATH);

    const parentBuild = buildSystemPrompt({
      cwd: parentCwd,
      contextFiles: [],
      skills: [],
    });
    const worktreeBuild = buildSystemPrompt({
      cwd: worktreePath,
      contextFiles: [],
      skills: [],
    });

    // The pre-fix bug: when distill spawned at worktreePath, this is
    // the prompt it built. Different from parentBuild → cache miss.
    expect(worktreeBuild).not.toBe(parentBuild);
  });

  test("only the `Current working directory:` line differs between parentCwd and worktreePath builds", async () => {
    // Defensive: confirm cwd is the ONLY cwd-derived content in the
    // prompt. If pi upstream adds another cwd-dependent line (e.g. a
    // skills section that walks `<cwd>/.pi/skills/`), this test would
    // surface that drift loudly. Today the test is path-blind because
    // we provide empty `contextFiles` and `skills`, but the assertion
    // pins the contract for any future cwd-dependent additions.
    const { buildSystemPrompt } = await import(PI_SYSTEM_PROMPT_PATH);

    const parentBuild = buildSystemPrompt({
      cwd: parentCwd,
      contextFiles: [],
      skills: [],
    });
    const worktreeBuild = buildSystemPrompt({
      cwd: worktreePath,
      contextFiles: [],
      skills: [],
    });

    // Both prompts should end with `Current working directory: <cwd>`.
    // Strip that final line from each and assert the remainders match.
    const stripCwdLine = (s: string): string =>
      s.replace(/\nCurrent working directory: [^\n]*$/, "");

    const parentStripped = stripCwdLine(parentBuild);
    const worktreeStripped = stripCwdLine(worktreeBuild);

    expect(worktreeStripped).toBe(parentStripped);
  });

  test("system prompt mentions the cwd verbatim (sanity check on prompt format)", async () => {
    // Belt-and-braces: the actual cwd string we passed should appear in
    // the output. Otherwise the byte-equality assertion above could be
    // vacuously true (e.g. if pi started normalising or hashing the
    // cwd).
    const { buildSystemPrompt } = await import(PI_SYSTEM_PROMPT_PATH);

    const parentBuild = buildSystemPrompt({
      cwd: parentCwd,
      contextFiles: [],
      skills: [],
    });

    // pi normalises Windows backslashes to forward slashes; on POSIX
    // platforms the cwd string is unchanged.
    const expected = parentCwd.replace(/\\/g, "/");
    expect(parentBuild).toContain(`Current working directory: ${expected}`);
  });

  test("all 8 buildSystemPrompt inputs populated: parent ⇄ distill match (R8-PERF-1)", async () => {
    // R8-PERF-1: the prior tests use `{ cwd, contextFiles: [], skills: [] }`
    // — only 3 of the 8 inputs pi's `buildSystemPrompt` actually accepts in
    // production. The other 5 (customPrompt, selectedTools, toolSnippets,
    // promptGuidelines, appendSystemPrompt) are merge-in-order surfaces
    // that could in principle interact with cwd-derived content. Pin the
    // invariant end-to-end: with ALL 8 inputs populated to realistic
    // non-empty values AND identical between the two calls, the outputs
    // must be byte-identical. This catches drift in `buildSystemPrompt`'s
    // own field-merging logic that an empty-inputs test would miss.
    const { buildSystemPrompt } = await import(PI_SYSTEM_PROMPT_PATH);

    // Realistic inputs that exercise each merge surface. Both calls use
    // exactly the same values; the only difference would come from
    // `buildSystemPrompt` itself doing something cwd-keyed beyond the
    // last `Current working directory:` line.
    const fullInputs = {
      cwd: parentCwd,
      customPrompt: undefined as string | undefined,
      selectedTools: ["read", "bash", "edit", "write"],
      toolSnippets: {
        read: "Read a file from disk",
        bash: "Execute a bash command",
        edit: "Edit a file in place",
        write: "Write content to a file",
      },
      promptGuidelines: [
        "Be concise in your responses",
        "Show file paths clearly when working with files",
      ],
      appendSystemPrompt: "Custom suffix for testing",
      contextFiles: [
        { path: "AGENTS.md", content: "# Project conventions\nUse bun." },
      ],
      skills: [],
    };

    const parentBuild = buildSystemPrompt(fullInputs);
    const distillBuild = buildSystemPrompt(fullInputs);

    expect(distillBuild).toBe(parentBuild);
  });

  test("all 8 inputs populated: cwd-only difference → only `Current working directory:` line differs (R8-PERF-1)", async () => {
    // Stronger version of the existing "only cwd line differs" test:
    // populates all 8 inputs (not just cwd + empty arrays) and checks
    // the cwd-line-stripped remainders are byte-identical. This catches
    // a cwd-dependent merge interaction in `buildSystemPrompt`'s tools/
    // guidelines/context plumbing that would surface with non-empty
    // inputs but stay invisible in the path-blind variant above.
    const { buildSystemPrompt } = await import(PI_SYSTEM_PROMPT_PATH);

    const baseInputs = {
      customPrompt: undefined as string | undefined,
      selectedTools: ["read", "bash", "edit", "write"],
      toolSnippets: {
        read: "Read a file from disk",
        bash: "Execute a bash command",
        edit: "Edit a file in place",
        write: "Write content to a file",
      },
      promptGuidelines: [
        "Be concise in your responses",
        "Show file paths clearly when working with files",
      ],
      appendSystemPrompt: "Custom suffix for testing",
      contextFiles: [
        { path: "AGENTS.md", content: "# Project conventions\nUse bun." },
      ],
      skills: [],
    };

    const parentBuild = buildSystemPrompt({ ...baseInputs, cwd: parentCwd });
    const worktreeBuild = buildSystemPrompt({
      ...baseInputs,
      cwd: worktreePath,
    });

    expect(worktreeBuild).not.toBe(parentBuild);

    const stripCwdLine = (s: string): string =>
      s.replace(/\nCurrent working directory: [^\n]*$/, "");
    expect(stripCwdLine(worktreeBuild)).toBe(stripCwdLine(parentBuild));
  });
});
