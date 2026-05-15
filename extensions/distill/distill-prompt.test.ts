/**
 * Unit tests for the distill prompt loader (PR #12 Item A1).
 *
 * The loader reads `extensions/distill/distill-prompt.md` and substitutes
 * four template placeholders. These tests cover:
 *   - happy path: returns string with placeholders substituted
 *   - empty input: throws (non-empty contract)
 *   - missing placeholder: throws when .md doesn't contain a required token
 *   - .md content invariants: 10 step markers + key prohibitive directives
 *     ("never use --force", "pull-merge", "do not loop indefinitely")
 *
 * Tests for missing-placeholder rebuild the .md in a tmpdir to avoid
 * mutating the shipped file, then reach into the loader by setting
 * a temporary symlink. Bun's test isolation is per-process, so
 * filesystem mutations between tests need explicit cleanup.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { buildDistillPrompt, DISTILL_PROMPT_PATH } from "./distill-prompt";

const SAMPLE_INPUTS = {
  worktreePath: "/tmp/distill-worktree-abc123",
  vaultPath: "/home/user/.napkin/notes",
  branchName: "distill/abc123-1700000000000",
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
    // worktree-isolation prefix AND in step 7 / step 10). All occurrences
    // must be replaced — replaceAll, not replace.
    const result = buildDistillPrompt(SAMPLE_INPUTS);
    const occurrences = result.split(SAMPLE_INPUTS.worktreePath).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
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
});

describe("buildDistillPrompt — template error paths", () => {
  // The error paths (missing placeholder, empty file, missing file) are
  // verified by patching `DISTILL_PROMPT_PATH` indirectly through a
  // helper that re-imports the loader against a tmpdir copy. Bun's
  // module-cache means we can't easily re-import after rewrite — but
  // we don't need to: the loader reads the file on every call (no
  // cache), so swapping the file at the canonical path covers it.
  //
  // Strategy: back up the real .md, write a degraded copy in its
  // place, run the assertion, restore. afterAll guards against test
  // crashes leaving the file mutated.

  const realPath = DISTILL_PROMPT_PATH;
  let backupContent: string;

  beforeAll(() => {
    backupContent = fs.readFileSync(realPath, "utf-8");
  });

  afterAll(() => {
    fs.writeFileSync(realPath, backupContent, "utf-8");
  });

  test("throws when a required placeholder is missing from the template", () => {
    // Write a template with only 3 of the 4 placeholders.
    const incomplete =
      "Worktree at {{worktreePath}}, vault at {{vaultPath}}, branch {{branchName}}. (no defaultBranch)";
    fs.writeFileSync(realPath, incomplete, "utf-8");
    try {
      expect(() => buildDistillPrompt(SAMPLE_INPUTS)).toThrow(
        /missing required placeholder '\{\{defaultBranch\}\}'/,
      );
    } finally {
      fs.writeFileSync(realPath, backupContent, "utf-8");
    }
  });

  test("throws when the template is empty", () => {
    fs.writeFileSync(realPath, "", "utf-8");
    try {
      expect(() => buildDistillPrompt(SAMPLE_INPUTS)).toThrow(/is empty/);
    } finally {
      fs.writeFileSync(realPath, backupContent, "utf-8");
    }
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

  test("template contains all 10 numbered step markers", () => {
    // We assert on `<n>.` at line-start (Markdown ordered-list shape) so
    // that a stray `1.` inside a sentence doesn't false-positive. The
    // 6th step is the frontmatter convention paragraph (numbered to
    // keep step counts aligned with the design spec).
    for (let n = 1; n <= 10; n++) {
      const stepHeader = new RegExp(`^${n}\\.`, "m");
      expect(template).toMatch(stepHeader);
    }
  });

  test("template prohibits force-push", () => {
    // Per design.md "Push behavior: never force". The .md must contain
    // explicit prohibitive language so the agent doesn't invent a
    // recovery path that calls `--force` or `--force-with-lease`.
    expect(template).toMatch(/--force/);
    expect(template).toMatch(/--force-with-lease|NEVER use `--force`/);
  });

  test("template prefers pull-merge over pull-rebase on push contention", () => {
    // Per design.md "Pull-merge, not pull-rebase". The .md must mention
    // pull-merge as the recovery path; "rebase" should appear only in
    // the prohibitive context (or not at all).
    expect(template).toMatch(/pull-merge/i);
  });

  test("template tells the agent not to loop indefinitely on push failure", () => {
    // Per design.md "Push behavior" agent-policy section.
    expect(template).toMatch(/do not loop indefinitely/i);
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
    // Step 7 ends where step 8 begins.
    const end = lines.findIndex((l, i) => i > start && /^8\. /.test(l));
    expect(end).toBeGreaterThan(start);
    const step7 = lines.slice(start, end).join("\n");

    // Each git operation in step 7 must use `git -C {{worktreePath}}`.
    expect(step7).toMatch(/git -C \{\{worktreePath\}\} add -A/);
    expect(step7).toMatch(/git -C \{\{worktreePath\}\} commit -m/);
    expect(step7).toMatch(
      /git -C \{\{worktreePath\}\} merge \{\{defaultBranch\}\}/,
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

  test("step 9 pull recovery uses --no-rebase (SEC-A-6)", () => {
    // The agent's pull recovery must override any global
    // `pull.rebase=true` config the user may have set. Without
    // `--no-rebase`, a rebase silently rewrites the recovery commit
    // shape and breaks the design's "linear forensic record" promise.
    expect(template).toMatch(
      /git -C \{\{vaultPath\}\} pull --no-rebase origin \{\{defaultBranch\}\}/,
    );
    // No bare `git pull origin` (without --no-rebase) anywhere in the
    // template, so the agent can't be tempted to copy a flagless variant.
    expect(template).not.toMatch(
      /git -C \{\{vaultPath\}\} pull origin \{\{defaultBranch\}\}(?!.*--no-rebase)/m,
    );
  });
});
