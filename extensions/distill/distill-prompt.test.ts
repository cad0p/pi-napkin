/**
 * Unit tests for the distill prompt loader (PR #12 Item A1).
 *
 * The loader reads `extensions/distill/distill-prompt.md` and substitutes
 * four template placeholders. These tests cover:
 *   - happy path: returns string with placeholders substituted
 *   - empty input: throws (non-empty contract)
 *   - missing placeholder: throws when .md doesn't contain a required token
 *   - .md content invariants: 7 step markers + the wrapper-owned-integration
 *     contract (no git against the live vault, read-only advisory line)
 *
 * Test isolation (CI-A-5): tests that exercise template error paths
 * (missing placeholder, empty file) write a degraded copy into a
 * per-test tmpdir and call `buildDistillPromptFromFile(<tmpdir-path>)`
 * — the shipped `.md` is never mutated. A regression-guard test at the
 * end of the file checksums the shipped `.md` to assert no test wrote
 * to the canonical path. Public-API callers (most tests) keep using
 * `buildDistillPrompt(inputs)` against the shipped artifact unchanged.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  buildDistillPrompt,
  buildDistillPromptFromFile,
  DISTILL_PROMPT_PATH,
} from "./distill-prompt";

// Production-shape fixture values (cross-reference distill-workspace.ts):
//   - vaultPath: arbitrary user vault root (a git repo). Not `.napkin/...`
//     which is the config subdir inside the vault.
//   - branchName: `distill/<6-hex-nonce>-<epoch-seconds>` per
//     generateDistillBranchName.
//   - worktreePath: `<XDG-cache>/napkin-distill/<16-hex-vault-hash>/<branch-suffix>`
//     per resolveCacheRoot + branchSuffix derivation in createDistillWorkspace.
const SAMPLE_INPUTS = {
  worktreePath:
    "/home/user/.cache/napkin-distill/a1b2c3d4e5f6a7b8/abc123-1700000000",
  vaultPath: "/home/user/Goldmine",
  branchName: "distill/abc123-1700000000",
  defaultBranch: "main",
};

describe("buildDistillPrompt — placeholder substitution", () => {
  test("returns a non-empty string with all placeholders substituted", () => {
    const result = buildDistillPrompt(SAMPLE_INPUTS);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain(SAMPLE_INPUTS.worktreePath);
    expect(result).toContain(SAMPLE_INPUTS.vaultPath);
    expect(result).toContain(SAMPLE_INPUTS.branchName);
    expect(result).toContain(SAMPLE_INPUTS.defaultBranch);
    // No leftover unresolved placeholders.
    expect(result).not.toContain("{{worktreePath}}");
    expect(result).not.toContain("{{vaultPath}}");
    expect(result).not.toContain("{{branchName}}");
    expect(result).not.toContain("{{defaultBranch}}");
  });

  test("substitutes the same placeholder in multiple positions", () => {
    // {{worktreePath}} appears more than once in the template (in the
    // worktree-isolation prefix AND in step 7). All occurrences must
    // be replaced — replaceAll, not replace.
    const result = buildDistillPrompt(SAMPLE_INPUTS);
    const occurrences = result.split(SAMPLE_INPUTS.worktreePath).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});

describe("buildDistillPrompt — full-document snapshot (regression guard, PR #12 C3)", () => {
  // The other describe blocks in this file assert specific substrings
  // (10 step markers, prohibitive directives, the worktree-isolation
  // prefix). Those are good for catching the named invariants but they
  // can't catch unintended drift in the surrounding prose — a
  // copy-edit that softens "never use --force" to "avoid using --force"
  // would still pass the substring asserts but might change agent
  // behavior subtly.
  //
  // The snapshot below pins the FULL rendered prompt at known sample
  // inputs. Any intentional prompt edit will require updating the
  // snapshot file (`bun test -u`) and the diff is reviewable.
  //
  // Snapshot file: extensions/distill/__snapshots__/distill-prompt.test.ts.snap
  // (Bun's default location, sibling to the test file.)

  test("rendered prompt matches snapshot at canonical inputs", () => {
    const rendered = buildDistillPrompt(SAMPLE_INPUTS);
    expect(rendered).toMatchSnapshot();
  });
});

describe("buildDistillPrompt — input validation", () => {
  for (const key of [
    "worktreePath",
    "vaultPath",
    "branchName",
    "defaultBranch",
  ] as const) {
    test(`throws when '${key}' is empty`, () => {
      const bad = { ...SAMPLE_INPUTS, [key]: "" };
      expect(() => buildDistillPrompt(bad)).toThrow(
        new RegExp(`'${key}' must be a non-empty string`),
      );
    });
  }

  // SEC-A-5: control characters in any input would inject prose into
  // the agent's prompt (newline = step boundary breakout). The validator
  // rejects the full \x00–\x1F + \x7F range; we sample the most
  // dangerous representatives plus a few less obvious ones to catch a
  // regex regression that narrowed the range.
  for (const key of [
    "worktreePath",
    "vaultPath",
    "branchName",
    "defaultBranch",
  ] as const) {
    for (const [label, ch] of [
      ["NUL (\\x00)", "\x00"],
      ["newline (\\n)", "\n"],
      ["CR (\\r)", "\r"],
      ["tab (\\t)", "\t"],
      ["BEL (\\x07)", "\x07"],
      ["ESC (\\x1b)", "\x1b"],
      ["DEL (\\x7f)", "\x7f"],
    ] as const) {
      test(`throws when '${key}' contains ${label}`, () => {
        const bad = { ...SAMPLE_INPUTS, [key]: `prefix${ch}suffix` };
        expect(() => buildDistillPrompt(bad)).toThrow(
          new RegExp(`'${key}' contains control characters`),
        );
      });
    }
  }

  // SEC-A-5: placeholder-syntax collisions. A vault path containing
  // `{{worktreePath}}` would silently re-substitute on a second pass.
  for (const key of [
    "worktreePath",
    "vaultPath",
    "branchName",
    "defaultBranch",
  ] as const) {
    for (const collide of ["{{worktreePath}}", "prefix{{", "suffix}}"]) {
      test(`throws when '${key}' contains placeholder syntax (${JSON.stringify(collide)})`, () => {
        const bad = { ...SAMPLE_INPUTS, [key]: collide };
        expect(() => buildDistillPrompt(bad)).toThrow(
          new RegExp(`'${key}' contains placeholder-syntax characters`),
        );
      });
    }
  }

  // SEC-A-5 (regression guard): realistic, valid inputs must still pass.
  // Spaces in paths, slashes in branch names, hyphens / dots / tildes
  // are all common shapes the validator MUST NOT reject.
  test("accepts realistic paths with spaces, hyphens, dots", () => {
    const inputs = {
      worktreePath: "/Users/alice/My Vault/.cache/napkin-distill/abc/dist",
      vaultPath: "/Users/alice/My Vault/notes",
      branchName: "distill/abc-123-1700000000000",
      defaultBranch: "main",
    };
    expect(() => buildDistillPrompt(inputs)).not.toThrow();
  });

  test("accepts branch names with slashes (e.g. feat/foo)", () => {
    // Distill branches are always `distill/<hex>-<epoch>` but the
    // validator must also pass a hypothetical default-branch name like
    // `release/2026-q1`. Slashes are not control chars and not
    // mustache delimiters; the regex must not regress to forbid them.
    const inputs = {
      ...SAMPLE_INPUTS,
      defaultBranch: "release/2026-q1",
      branchName: "distill/feat-foo-1700000000000",
    };
    expect(() => buildDistillPrompt(inputs)).not.toThrow();
  });
});

describe("buildDistillPrompt — template error paths", () => {
  // CI-A-5: these tests exercise the loader's template-error branches
  // (missing placeholder, empty file). Earlier versions of this suite
  // mutated the shipped `.md` in place, which polluted the bundled
  // artifact between runs and risked committing test residue. We now
  // write the degraded template into a per-test-suite tmpdir and call
  // `buildDistillPromptFromFile(<tmpdir-path>)` — the seam exists
  // exactly so this test no longer touches the shipped file.

  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "distill-prompt-test-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("throws when a required placeholder is missing from the template", () => {
    // Write a template with only 3 of the 4 placeholders.
    const incomplete =
      "Worktree at {{worktreePath}}, vault at {{vaultPath}}, branch {{branchName}}. (no defaultBranch)";
    const fakePath = path.join(tmpDir, "missing-placeholder.md");
    fs.writeFileSync(fakePath, incomplete, "utf-8");
    expect(() => buildDistillPromptFromFile(fakePath, SAMPLE_INPUTS)).toThrow(
      /missing required placeholder '\{\{defaultBranch\}\}'/,
    );
  });

  test("throws when the template is empty", () => {
    const fakePath = path.join(tmpDir, "empty.md");
    fs.writeFileSync(fakePath, "", "utf-8");
    expect(() => buildDistillPromptFromFile(fakePath, SAMPLE_INPUTS)).toThrow(
      /is empty/,
    );
  });

  test("throws when the template file is missing", () => {
    // Bonus coverage for the read-failure branch — not previously
    // exercised because the shipped path always existed.
    const fakePath = path.join(tmpDir, "does-not-exist.md");
    expect(() => buildDistillPromptFromFile(fakePath, SAMPLE_INPUTS)).toThrow(
      /failed to read prompt template/,
    );
  });
});

describe("buildDistillPromptFromFile — path-injection seam (CI-A-5)", () => {
  // Smoke test for the public seam: a tmpdir copy of the shipped .md
  // produces the same output as the default `buildDistillPrompt` call.
  // This locks the seam in: future refactors that would silently drop
  // the override (e.g. caching the path at module load) break this test.

  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "distill-prompt-seam-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("buildDistillPromptFromFile against a copy returns same output as buildDistillPrompt", () => {
    const copyPath = path.join(tmpDir, "distill-prompt.md");
    fs.copyFileSync(DISTILL_PROMPT_PATH, copyPath);
    const fromDefault = buildDistillPrompt(SAMPLE_INPUTS);
    const fromCopy = buildDistillPromptFromFile(copyPath, SAMPLE_INPUTS);
    expect(fromCopy).toBe(fromDefault);
  });
});

describe("distill-prompt.md — content invariants", () => {
  // Read the template directly (bypass the loader's substitution) so we
  // assert on the source-of-truth shape, not on a particular substitution.
  const template = fs.readFileSync(DISTILL_PROMPT_PATH, "utf-8");

  test("template is non-empty", () => {
    expect(template.length).toBeGreaterThan(0);
  });

  test("template contains all 4 required placeholders", () => {
    expect(template).toContain("{{worktreePath}}");
    expect(template).toContain("{{vaultPath}}");
    expect(template).toContain("{{branchName}}");
    expect(template).toContain("{{defaultBranch}}");
  });

  test("template contains all 7 numbered step markers", () => {
    // We assert on `<n>.` at line-start (Markdown ordered-list shape) so
    // that a stray `1.` inside a sentence doesn't false-positive. The
    // 6th step is the frontmatter convention paragraph (numbered to
    // keep step counts aligned with the design spec). Issue #122 moved
    // squash + push + cleanup out of the agent's contract and into the
    // wrapper, so the prompt ends at step 7 (commit + catch-up merge).
    for (let n = 1; n <= 7; n++) {
      const stepHeader = new RegExp(`^${n}\\.`, "m");
      expect(template).toMatch(stepHeader);
    }
  });

  test("template does NOT contain a step 10 / agent-side worktree-removal directive", () => {
    // The wrapper owns worktree + branch cleanup (its EXIT trap and
    // salvage path both run `git worktree remove` after writing the
    // outcome sidecar). Asking the agent to do it too creates a race
    // window where the JS-side poller can observe the worktree gone
    // before the wrapper writes the outcome — the JS-side then dispatches
    // a spurious "terminated abnormally" warning. Negative assertions:
    const lines = template.split("\n");
    expect(lines.some((l) => /^10\./.test(l))).toBe(false);
    expect(template).not.toMatch(/git -C \{\{vaultPath\}\} worktree remove/);
    expect(template).not.toMatch(/git -C \{\{vaultPath\}\} branch -D/);
  });

  test("template never asks the agent to land, push or clean up (issue #122)", () => {
    // Issue #122: the wrapper owns catch-up, squash, push and cleanup.
    // The agent must not be told (or allowed) to run any landing verb,
    // because the wrapper's read-only + marker + preflight gates only
    // bind when the wrapper owns the landing path.
    expect(template).not.toMatch(/\{\{vaultPath\}\} push/);
    expect(template).not.toMatch(/\{\{vaultPath\}\} merge --squash/);
    expect(template).not.toMatch(/pull --no-rebase/);
    expect(template).not.toMatch(/worktree remove/);
    expect(template).not.toMatch(/branch -D/);
    // The only remaining defensible landing mention is the explicit
    // prohibition list in step 7.
    expect(template).toMatch(/forbidden on any branch/);
    expect(template).toMatch(/The wrapper is the only thing that lands/);
  });

  test("template contains the worktree-isolation cwd contract from POST-R6-CACHE", () => {
    // Per design.md "Open questions" → "Worktree-isolation prompt prefix
    // from POST-R6-CACHE: keep". The opening lines must spell out the
    // cwd contract: agent's shell cwd is PARENT_CWD, NOT the worktree,
    // so git ops must use `git -C {{worktreePath}}`. Replaces the
    // pre-fix "You are running in an isolated git worktree at..."
    // wording (CLEAN-A-2 / CLEAN-A-3) which falsely claimed cwd was
    // the worktree.
    expect(template).toMatch(/git -C \{\{worktreePath\}\}/);
    expect(template).toMatch(/your shell cwd is NOT the worktree/i);
  });

  test("step 7 uses `git -C {{worktreePath}}` for all git operations (CLEAN-A-2)", () => {
    // Step 7 commits + merges from inside the worktree. Bare
    // `git merge` / `git add -A` / `git commit -m` would run against
    // PARENT_CWD (the agent's actual shell cwd) and either corrupt the
    // parent project repo or fail. Every git invocation in step 7
    // must be qualified with `-C {{worktreePath}}`.
    const lines = template.split("\n");
    const start = lines.findIndex((l) => /^7\. /.test(l));
    expect(start).toBeGreaterThan(-1);
    // Step 7 is the last step: issue #122 dropped steps 8-9 (squash and
    // push are wrapper-owned), so step 7 runs to the end of the file.
    const step7 = lines.slice(start).join("\n");
    expect(step7.length).toBeGreaterThan(0);

    // Each git operation in step 7 must use `git -C {{worktreePath}}`.
    expect(step7).toMatch(/git -C \{\{worktreePath\}\} add -A/);
    expect(step7).toMatch(/git -C \{\{worktreePath\}\} commit -m/);
    expect(step7).toMatch(
      /git -C \{\{worktreePath\}\} merge --no-edit \{\{defaultBranch\}\}/,
    );
    expect(step7).toMatch(/git -C \{\{worktreePath\}\} add \./);
    expect(step7).toMatch(/git -C \{\{worktreePath\}\} commit --no-edit/);

    // No bare git invocations on a line by themselves (after stripping
    // leading whitespace). The conflict-marker prose contains the
    // word "git" inside backticks, which is fine; what we forbid is a
    // command line like `       git merge {{defaultBranch}}`.
    const codeLines = step7.split("\n").filter((l) => /^\s{4,}git\b/.test(l));
    for (const codeLine of codeLines) {
      expect(codeLine).toMatch(/git -C \{\{worktreePath\}\}/);
    }
  });

  test("step 7 merge uses --no-edit to avoid TTY-editor hang (CLEAN-11)", () => {
    // Round 2 regression: without `--no-edit`, `git merge` on a clean
    // auto-merge (non-fast-forward) opens core.editor for the merge
    // commit message. The agent's bash tool has no TTY, so the editor
    // call hangs or returns non-zero — the agent then retries blindly
    // or aborts the distill. The prompt MUST pass `--no-edit` so git
    // accepts its auto-generated message non-interactively.
    expect(template).toMatch(
      /git -C \{\{worktreePath\}\} merge --no-edit \{\{defaultBranch\}\}/,
    );
    // No bare `git -C {{worktreePath}} merge {{defaultBranch}}` on a
    // line by itself (without --no-edit). Use a negative lookahead to
    // catch a regression that would silently drop the flag.
    expect(template).not.toMatch(
      /git -C \{\{worktreePath\}\} merge \{\{defaultBranch\}\}/,
    );
  });

  test("step 7 has an explicit no-content branch that exits cleanly", () => {
    // If the agent decided nothing in the conversation merits capturing
    // (per the "Be selective" directive), running step 7's `git commit
    // -m "distill: ..."` would fail with `nothing to commit, working
    // tree clean` and the agent would interpret that as an error. The
    // prompt must explicitly tell the agent how to exit cleanly in the
    // no-content case: skip steps 7-9 and exit. The wrapper's
    // commit-count validator then classifies the run as `no-content`
    // (a warning, not a failure).
    const lines = template.split("\n");
    const start = lines.findIndex((l) => /^7\. /.test(l));
    const step7 = lines.slice(start).join("\n");
    expect(step7).toMatch(/nothing in this conversation merits capturing/i);
    expect(step7).toMatch(/skip step 7/i);
    expect(step7).toMatch(/exit/i);
  });

  test("prefix tells the agent the wrapper lands the branch (issue #122)", () => {
    // Issue #122 moved integration into the wrapper: the agent no longer
    // owns squash/push/cleanup, so the prefix must say so and must not
    // carve out an "integration phase" that legitimises
    // `git -C {{vaultPath}}` commands. The old CLEAN-4 contradiction
    // (prefix forbids vault writes, steps 8-9 require them) is resolved
    // by removing the steps, not by qualifying the prohibition.
    expect(template).toMatch(/The wrapper that invoked you lands your branch/);
    expect(template).toMatch(/Your job ends at step 7/);
    expect(template).toMatch(/do not edit files under `\{\{vaultPath\}\}`/);
    expect(template).not.toMatch(/git -C \{\{vaultPath\}\}/);
    expect(template).not.toMatch(/steps 7-9/);
  });

  test("no git command in the prompt targets the live vault (issue #122)", () => {
    // The vault-path subset of the #117 tool_call gate blocks the agent's
    // own `git -C <vault>` anyway; the prompt must not invite one, so a
    // literalist agent never plans around a gate it cannot pass. Any
    // `git -C {{vaultPath}}` occurrence is a defect: it is either a
    // landing command or a rule the agent cannot follow.
    expect(template).not.toMatch(/git -C \{\{vaultPath\}\}/);
    expect(template).not.toMatch(
      /\{\{vaultPath\}\} (checkout|merge|commit|push|pull|reset|rebase|update-ref)/,
    );
  });

  test("step 7 forbids landing branches", () => {
    // 2026-11-05 incident: the agent built a private landing-branch family
    // (distill-land/<session>a/b/c) in a scratch worktree and pointed main
    // at each tip. The prompt must scope the agent to the one distill
    // branch it was given.
    const lines = template.split("\n");
    const start = lines.findIndex((l) => /^7\. /.test(l));
    const step7 = lines.slice(start).join("\n");
    expect(step7).toMatch(/Do not create landing branches/);
    expect(step7).toMatch(/The only branch you may create or move is/);
  });

  test("step 7 forbids plumbing ref writes and every landing verb", () => {
    // Issue #121 pinned the plumbing-ref prohibitions in step 8; issue
    // #122 moved landing into the wrapper, so the same prohibitions now
    // live in step 7 (the last step) together with the landing verbs the
    // agent must never run. A literalist agent needs every verb named.
    const lines = template.split("\n");
    const start = lines.findIndex((l) => /^7\. /.test(l));
    const step7 = lines.slice(start).join("\n");

    for (const verb of [
      "git update-ref",
      "git branch -f",
      "git checkout -B",
      "git switch -C",
      "git reset",
      "git rebase",
      "git commit --amend",
      "git merge --squash",
      "git push",
      "git fetch .",
    ]) {
      expect(step7).toContain(verb);
    }
    expect(step7).toMatch(/forbidden on any branch/);
    expect(step7).toMatch(/stop and report the failure/);
  });

  test("the read-only advisory line is present (issue #122, Q1)", () => {
    // The gate is the tree-diff check in the wrapper; the prompt line is
    // advisory only, but it must be present so the agent does not spend
    // the run editing notes the wrapper will drop (and so a human
    // reading the prompt sees the rule).
    expect(template).toMatch(/read-only list \(PR and issue notes\)/);
    expect(template).toMatch(/projection sources/);
    expect(template).toMatch(/do not edit, create or delete them/);
    expect(template).toMatch(/changelog, reflections or daily note/);
    expect(template).toMatch(/link the PR note/);
  });
});

describe("distill-prompt.md — shipped artifact is unmodified by tests (CI-A-5)", () => {
  // Regression guard: the test suite must NEVER write to the shipped
  // .md. Earlier revisions of distill-prompt.test.ts mutated the file
  // in place during template-error tests, polluting the bundled
  // artifact between runs and risking committing test residue. After
  // the path-injection seam refactor, all mutating tests target a
  // tmpdir copy via `buildDistillPromptFromFile`. We capture the
  // shipped .md's hash at suite start and re-check at the end of this
  // describe block (which Bun runs after the prior describes per
  // file-order). If the hash drifts, a future test has reintroduced
  // direct mutation — fail loudly.
  //
  // Note: this isn't a perfect guard (the file could be mutated and
  // restored between the two reads), but in practice the prior
  // pattern was "mutate, finally restore on the SAME test", which
  // would still leak if the test crashed before the finally. The
  // refactor eliminates the mutation pattern entirely; this test is
  // the canary that catches regressions.

  const expectedHash = createHash("sha256")
    .update(fs.readFileSync(DISTILL_PROMPT_PATH))
    .digest("hex");

  test("shipped distill-prompt.md sha256 is stable across the suite", () => {
    const currentHash = createHash("sha256")
      .update(fs.readFileSync(DISTILL_PROMPT_PATH))
      .digest("hex");
    expect(currentHash).toBe(expectedHash);
  });
});
