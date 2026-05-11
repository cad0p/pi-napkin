import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  countTrackedFiles,
  ensureVaultReadyForAutoDistill,
  GITATTRIBUTES_LINES,
  GITIGNORE_LINES,
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
