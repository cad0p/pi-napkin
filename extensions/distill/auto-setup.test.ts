import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  countTrackedFiles,
  detectConflictingMdMergeRule,
  ensureVaultReadyForAutoDistill,
  GITATTRIBUTES_LINES,
  GITIGNORE_LINES,
  NAPKIN_MERGE_DRIVER,
} from "./auto-setup";

/**
 * Spawn git with a fixed identity so tests don't trip on whatever the CI
 * runner configured globally.
 */
function git(cwd: string, args: string[]) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  return spawnSync("git", args, { cwd, env, encoding: "utf-8" });
}

describe("ensureVaultReadyForAutoDistill", () => {
  let vault: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), "auto-setup-"));
    // Configure git identity inside the temp dir via env (commit uses env
    // vars, init does not need one).
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  /**
   * Helper: run setup under a git identity env so the initial commit succeeds
   * even when the CI runner has no default author configured.
   */
  function runSetup(): ReturnType<typeof ensureVaultReadyForAutoDistill> {
    const saved = {
      name: process.env.GIT_AUTHOR_NAME,
      email: process.env.GIT_AUTHOR_EMAIL,
      cname: process.env.GIT_COMMITTER_NAME,
      cemail: process.env.GIT_COMMITTER_EMAIL,
      sign: process.env.GIT_CONFIG_COUNT,
    };
    process.env.GIT_AUTHOR_NAME = "test";
    process.env.GIT_AUTHOR_EMAIL = "test@example.com";
    process.env.GIT_COMMITTER_NAME = "test";
    process.env.GIT_COMMITTER_EMAIL = "test@example.com";
    // Disable gpg signing via git config override through env so commit
    // succeeds on boxes where commit.gpgsign=true is the default.
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "commit.gpgsign";
    process.env.GIT_CONFIG_VALUE_0 = "false";
    try {
      return ensureVaultReadyForAutoDistill({ contentPath: vault });
    } finally {
      if (saved.name === undefined) delete process.env.GIT_AUTHOR_NAME;
      else process.env.GIT_AUTHOR_NAME = saved.name;
      if (saved.email === undefined) delete process.env.GIT_AUTHOR_EMAIL;
      else process.env.GIT_AUTHOR_EMAIL = saved.email;
      if (saved.cname === undefined) delete process.env.GIT_COMMITTER_NAME;
      else process.env.GIT_COMMITTER_NAME = saved.cname;
      if (saved.cemail === undefined) delete process.env.GIT_COMMITTER_EMAIL;
      else process.env.GIT_COMMITTER_EMAIL = saved.cemail;
      if (saved.sign === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = saved.sign;
      delete process.env.GIT_CONFIG_KEY_0;
      delete process.env.GIT_CONFIG_VALUE_0;
    }
  }

  test("fresh vault (no .git): initializes repo + writes scaffolds + commits", () => {
    // Some existing content so the initial commit isn't empty-tree.
    fs.writeFileSync(path.join(vault, "notes.md"), "# notes\n");

    const r = runSetup();

    expect(r.initialized).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.scaffolded).toContain(".gitignore");
    expect(r.scaffolded).toContain(".gitattributes");
    expect(fs.existsSync(path.join(vault, ".git"))).toBe(true);

    const gi = fs.readFileSync(path.join(vault, ".gitignore"), "utf-8");
    expect(gi).toContain(".napkin/distill/");
    expect(gi).toContain(".obsidian/workspace*.json");
    const ga = fs.readFileSync(path.join(vault, ".gitattributes"), "utf-8");
    expect(ga).toContain("*.md merge=napkin-distill-merge");

    const log = git(vault, ["log", "--oneline"]).stdout;
    expect(log).toContain("napkin: initial vault commit (auto-distill setup)");
  });

  test("fresh vault: .gitignore contains common secret patterns (SEC-5)", () => {
    // Auto-distill commits 'git add .' on first init; belt-and-braces
    // patterns here keep credentials out of the initial commit even when
    // a user's vault happens to coexist with dev work. Pattern list is
    // intentionally stable — this test pins it so a future refactor
    // doesn't silently drop protections.
    fs.writeFileSync(path.join(vault, "notes.md"), "# notes\n");
    const r = runSetup();
    expect(r.error).toBeUndefined();

    const gi = fs.readFileSync(path.join(vault, ".gitignore"), "utf-8");
    for (const pattern of [
      ".env",
      ".env.local",
      ".env.*.local",
      "*.pem",
      "*.key",
      "id_rsa",
      "id_ecdsa",
      "id_ed25519",
      "secrets.json",
      ".aws/credentials",
    ]) {
      expect(gi).toContain(pattern);
    }
  });

  test("fresh vault: secret files already present at init are NOT committed (SEC-5)", () => {
    // End-to-end check: create .env and id_rsa alongside a normal note,
    // run setup, assert the secrets were excluded from the initial
    // commit's tracked files. Prevents the scenario where a user's
    // first-run commit silently captures credentials.
    fs.writeFileSync(path.join(vault, "notes.md"), "# notes\n");
    fs.writeFileSync(path.join(vault, ".env"), "API_KEY=secret\n");
    fs.writeFileSync(
      path.join(vault, "id_rsa"),
      "-----BEGIN PRIVATE KEY-----\n",
    );
    fs.writeFileSync(
      path.join(vault, "cert.pem"),
      "-----BEGIN CERTIFICATE-----\n",
    );

    const r = runSetup();
    expect(r.error).toBeUndefined();
    expect(r.initialized).toBe(true);

    const tracked = git(vault, ["ls-files"]).stdout;
    expect(tracked).toContain("notes.md");
    expect(tracked).not.toContain(".env");
    expect(tracked).not.toContain("id_rsa");
    expect(tracked).not.toContain("cert.pem");
  });

  test("vault with git but no .gitignore: writes scaffolds, commits", () => {
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(vault, "readme.md"), "# r\n");
    git(vault, ["add", "readme.md"]);
    git(vault, ["commit", "-q", "-m", "seed"]);
    const before = git(vault, ["rev-parse", "HEAD"]).stdout.trim();

    const r = runSetup();

    expect(r.initialized).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.scaffolded.sort()).toEqual([".gitattributes", ".gitignore"]);

    const after = git(vault, ["rev-parse", "HEAD"]).stdout.trim();
    expect(after).not.toBe(before);

    const msg = git(vault, ["log", "-1", "--format=%s"]).stdout.trim();
    expect(msg).toBe("napkin: scaffold auto-distill git config");
  });

  test("idempotent: running twice on the same vault is a no-op on the second run", () => {
    fs.writeFileSync(path.join(vault, "f.md"), "# f\n");
    const first = runSetup();
    expect(first.scaffolded.length).toBeGreaterThan(0);
    const headAfterFirst = git(vault, ["rev-parse", "HEAD"]).stdout.trim();

    const second = runSetup();
    expect(second.initialized).toBe(false);
    expect(second.scaffolded).toEqual([]);
    expect(second.error).toBeUndefined();

    const headAfterSecond = git(vault, ["rev-parse", "HEAD"]).stdout.trim();
    expect(headAfterSecond).toBe(headAfterFirst);
  });

  test("existing .gitignore with user content: merges napkin lines, preserves user lines", () => {
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(vault, ".gitignore"), "# user\nnode_modules/\n");
    git(vault, ["add", ".gitignore"]);
    git(vault, ["commit", "-q", "-m", "user gitignore"]);

    const r = runSetup();

    const gi = fs.readFileSync(path.join(vault, ".gitignore"), "utf-8");
    expect(gi).toContain("# user");
    expect(gi).toContain("node_modules/");
    expect(gi).toContain(".napkin/distill/");
    expect(gi).toContain("search-cache.json");
    expect(r.scaffolded).toContain(".gitignore");
  });

  test("existing .gitignore already contains napkin lines: only writes .gitattributes", () => {
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(
      path.join(vault, ".gitignore"),
      `${GITIGNORE_LINES.join("\n")}\n`,
    );
    git(vault, ["add", ".gitignore"]);
    git(vault, ["commit", "-q", "-m", "preseeded"]);

    const r = runSetup();

    expect(r.scaffolded).not.toContain(".gitignore");
    expect(r.scaffolded).toContain(".gitattributes");
  });

  test("partial-setup vault (git + .gitignore only): fills in .gitattributes", () => {
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(
      path.join(vault, ".gitignore"),
      `${GITIGNORE_LINES.join("\n")}\n`,
    );
    git(vault, ["add", "."]);
    git(vault, ["commit", "-q", "-m", "partial seed"]);

    const r = runSetup();

    expect(r.scaffolded).toEqual([".gitattributes"]);
    const ga = fs.readFileSync(path.join(vault, ".gitattributes"), "utf-8");
    for (const line of GITATTRIBUTES_LINES) {
      expect(ga).toContain(line);
    }
  });

  test("simulated permission failure: git init fails without throwing", () => {
    const ro = fs.mkdtempSync(path.join(os.tmpdir(), "ro-vault-"));
    fs.chmodSync(ro, 0o500);
    try {
      const savedName = process.env.GIT_AUTHOR_NAME;
      process.env.GIT_AUTHOR_NAME = "test";
      try {
        const r = ensureVaultReadyForAutoDistill({ contentPath: ro });
        // If the kernel didn't enforce the read-only (common under root /
        // bind mounts), the setup may actually succeed. Either way, the
        // contract is: no throw.
        if (r.error) {
          expect(r.error).toMatch(/git (init|add|commit) failed/);
          expect(r.initialized).toBe(false);
        }
      } finally {
        if (savedName === undefined) delete process.env.GIT_AUTHOR_NAME;
        else process.env.GIT_AUTHOR_NAME = savedName;
      }
    } finally {
      fs.chmodSync(ro, 0o700);
      fs.rmSync(ro, { recursive: true, force: true });
    }
  });

  // --- G7: conflicting `*.md merge=<X>` detection ------------------------

  test("G7: fresh vault (no conflict) → no `conflict`, scaffolding proceeds", () => {
    const r = runSetup();
    expect(r.error).toBeUndefined();
    expect(r.conflict).toBeUndefined();
    expect(r.scaffolded).toContain(".gitattributes");
  });

  test("G7: idempotent when our rule already present → no conflict", () => {
    // First run scaffolds.
    expect(runSetup().error).toBeUndefined();
    // Second run: our own `*.md merge=napkin-distill-merge` is NOT a conflict.
    const r2 = runSetup();
    expect(r2.error).toBeUndefined();
    expect(r2.conflict).toBeUndefined();
    expect(r2.scaffolded).toEqual([]);
  });

  test("G7: `*.md merge=union` in existing .gitattributes → conflict, no scaffolding", () => {
    // Existing git repo with a prior `*.md merge=union` rule.
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(vault, ".gitattributes"), "*.md merge=union\n");
    const r = runSetup();
    expect(r.error).toBeDefined();
    expect(r.error).toMatch(/conflicting merge rule/);
    expect(r.conflict).toBeDefined();
    expect(r.conflict?.driver).toBe("union");
    expect(r.conflict?.rule).toBe("*.md merge=union");
    expect(r.conflict?.file).toBe(path.join(vault, ".gitattributes"));
    // We must not have overridden the user's rule.
    const ga = fs.readFileSync(path.join(vault, ".gitattributes"), "utf-8");
    expect(ga).toBe("*.md merge=union\n");
    expect(ga).not.toContain(NAPKIN_MERGE_DRIVER);
    // And nothing was scaffolded even for .gitignore (refuse atomically).
    expect(r.scaffolded).toEqual([]);
  });

  test("G7: narrower pattern (changelog/**) does NOT trigger conflict, scaffolds normally", () => {
    // A `changelog/** merge=union` rule exists on a different pattern; our
    // `*.md` pattern doesn't EXACTLY match it, so detection (narrowly
    // scoped to literal `*.md`) passes through. Pattern-overlap is out of
    // scope for G7 by design — too noisy to flag broadly.
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(
      path.join(vault, ".gitattributes"),
      "changelog/** merge=union\n",
    );
    const r = runSetup();
    expect(r.error).toBeUndefined();
    expect(r.conflict).toBeUndefined();
    expect(r.scaffolded).toContain(".gitattributes");
    // User's rule preserved, our rule appended.
    const ga = fs.readFileSync(path.join(vault, ".gitattributes"), "utf-8");
    expect(ga).toContain("changelog/** merge=union");
    expect(ga).toContain(`*.md merge=${NAPKIN_MERGE_DRIVER}`);
  });

  test("G7: defensive — our rule PLUS a conflicting rule on the same file is flagged", () => {
    // A vault that has both our driver AND an opposing `*.md merge=union`
    // (e.g. user edited the file). gitattributes is last-match-wins, so
    // whichever comes LAST actually takes effect. Our detector walks top
    // to bottom and reports the FIRST non-napkin driver it encounters —
    // that's enough to alert the user; precise resolution is their job.
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(
      path.join(vault, ".gitattributes"),
      `*.md merge=${NAPKIN_MERGE_DRIVER}\n*.md merge=union\n`,
    );
    const r = runSetup();
    expect(r.error).toMatch(/conflicting merge rule/);
    expect(r.conflict?.driver).toBe("union");
  });
});

describe("detectConflictingMdMergeRule (G7)", () => {
  let vault: string;
  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), "g7-detect-"));
  });
  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  const ga = () => path.join(vault, ".gitattributes");

  test("missing .gitattributes → null", () => {
    expect(detectConflictingMdMergeRule(ga())).toBeNull();
  });

  test("empty .gitattributes → null", () => {
    fs.writeFileSync(ga(), "");
    expect(detectConflictingMdMergeRule(ga())).toBeNull();
  });

  test("only comments → null", () => {
    fs.writeFileSync(ga(), "# comment\n# another\n");
    expect(detectConflictingMdMergeRule(ga())).toBeNull();
  });

  test("our own rule → null (idempotent)", () => {
    fs.writeFileSync(ga(), `*.md merge=${NAPKIN_MERGE_DRIVER}\n`);
    expect(detectConflictingMdMergeRule(ga())).toBeNull();
  });

  test("foreign `*.md merge=union` → conflict", () => {
    fs.writeFileSync(ga(), "*.md merge=union\n");
    const r = detectConflictingMdMergeRule(ga());
    expect(r).not.toBeNull();
    expect(r?.driver).toBe("union");
    expect(r?.rule).toBe("*.md merge=union");
  });

  test("extra attributes on the same line → still detected", () => {
    // gitattributes allows multiple attributes per line; ours is noise, the
    // merge= one is what matters. Detection must survive diff=/text/etc.
    fs.writeFileSync(ga(), "*.md text diff=markdown merge=ours\n");
    const r = detectConflictingMdMergeRule(ga());
    expect(r?.driver).toBe("ours");
  });

  test("different pattern (changelog/**) → null (scope is exact `*.md`)", () => {
    fs.writeFileSync(ga(), "changelog/** merge=union\n");
    expect(detectConflictingMdMergeRule(ga())).toBeNull();
  });

  test("`*.md` rule WITHOUT a merge attribute → null (no driver, no conflict)", () => {
    fs.writeFileSync(ga(), "*.md text\n");
    expect(detectConflictingMdMergeRule(ga())).toBeNull();
  });
});

describe("countTrackedFiles", () => {
  let vault: string;
  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), "count-files-"));
  });
  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test("returns -1 when not a git repo", () => {
    expect(countTrackedFiles(vault)).toBe(-1);
  });

  test("returns the count of tracked files in a seeded repo", () => {
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(vault, "a.md"), "a");
    fs.writeFileSync(path.join(vault, "b.md"), "b");
    git(vault, ["add", "."]);
    git(vault, ["commit", "-q", "-m", "seed"]);
    expect(countTrackedFiles(vault)).toBe(2);
  });
});
