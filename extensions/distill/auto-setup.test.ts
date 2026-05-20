import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  BLOCK_CONTENT,
  BLOCK_MARKER_BEGIN,
  BLOCK_MARKER_END,
  countTrackedFiles,
  ensureVaultReadyForDistill,
  GITIGNORE_LINES,
  type HealthLevel,
  LEGACY_EMBEDDED_LAYOUT_ERROR,
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

/**
 * Render the canonical managed-block region as a string, suitable for
 * dropping into a `.gitignore` fixture (with surrounding user content,
 * leading/trailing newlines, etc.).
 */
function canonicalBlock(): string {
  return `${BLOCK_MARKER_BEGIN}\n${BLOCK_CONTENT.join("\n")}\n${BLOCK_MARKER_END}\n`;
}

describe("ensureVaultReadyForDistill", () => {
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
  function runSetup(
    level: HealthLevel = "fast",
  ): ReturnType<typeof ensureVaultReadyForDistill> {
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
      // Subdir layout: configPath is a distinct path from contentPath.
      // The legacy-embedded-layout check compares string equality only;
      // the path doesn't need to exist on disk for the happy-path tests.
      return ensureVaultReadyForDistill(
        {
          contentPath: vault,
          configPath: path.join(vault, ".napkin"),
        },
        level,
      );
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
    expect(r.findings).toEqual([
      {
        kind: "auto-recovered",
        invariant: "vault-is-git-repo",
        message: expect.any(String),
        recovery: "ran git init",
      },
      {
        kind: "auto-recovered",
        invariant: "gitignore-block-correct",
        message: expect.any(String),
        recovery: "installed",
      },
    ]);
    expect(r.scaffolded).toContain(".gitignore");
    // PR #12: no `.gitattributes` is written by auto-setup any more (the
    // merge driver was removed; the agent owns merge resolution in its
    // worktree).
    expect(r.scaffolded).not.toContain(".gitattributes");
    expect(fs.existsSync(path.join(vault, ".gitattributes"))).toBe(false);
    expect(fs.existsSync(path.join(vault, ".git"))).toBe(true);

    const gi = fs.readFileSync(path.join(vault, ".gitignore"), "utf-8");
    expect(gi).toContain(".napkin/distill/");
    expect(gi).toContain(".obsidian/workspace*.json");

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
    expect(r.findings).toEqual([
      {
        kind: "auto-recovered",
        invariant: "gitignore-block-correct",
        message: expect.any(String),
        recovery: "installed",
      },
    ]);
    // PR #12: only `.gitignore` is scaffolded (no `.gitattributes`).
    expect(r.scaffolded).toEqual([".gitignore"]);

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
    expect(second.findings).toEqual([]);

    const headAfterSecond = git(vault, ["rev-parse", "HEAD"]).stdout.trim();
    expect(headAfterSecond).toBe(headAfterFirst);
  });

  test("existing .gitignore with user content: installs block, preserves user lines", () => {
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(vault, ".gitignore"), "# user\nnode_modules/\n");
    git(vault, ["add", ".gitignore"]);
    git(vault, ["commit", "-q", "-m", "user gitignore"]);

    const r = runSetup();

    const gi = fs.readFileSync(path.join(vault, ".gitignore"), "utf-8");
    expect(gi).toContain("# user");
    expect(gi).toContain("node_modules/");
    expect(gi).toContain(BLOCK_MARKER_BEGIN);
    expect(gi).toContain(BLOCK_MARKER_END);
    expect(gi).toContain(".napkin/distill/");
    expect(gi).toContain("search-cache.json");
    expect(r.scaffolded).toContain(".gitignore");
    expect(r.findings).toEqual([
      {
        kind: "auto-recovered",
        invariant: "gitignore-block-correct",
        message: expect.any(String),
        recovery: "installed",
      },
    ]);
  });

  test("existing .gitignore already contains napkin block: no-op (no scaffolding)", () => {
    // PR #12: pre-PR-12 this test asserted that `.gitattributes` would be
    // scaffolded if `.gitignore` was already complete. The merge driver is
    // gone, so a complete `.gitignore` means there's nothing left for
    // auto-setup to scaffold.
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(vault, ".gitignore"), canonicalBlock());
    git(vault, ["add", ".gitignore"]);
    git(vault, ["commit", "-q", "-m", "preseeded"]);

    const r = runSetup();

    expect(r.error).toBeUndefined();
    expect(r.scaffolded).toEqual([]);
    expect(r.findings).toEqual([]);
  });

  test("simulated permission failure: git init fails without throwing", () => {
    const ro = fs.mkdtempSync(path.join(os.tmpdir(), "ro-vault-"));
    fs.chmodSync(ro, 0o500);
    try {
      const savedName = process.env.GIT_AUTHOR_NAME;
      process.env.GIT_AUTHOR_NAME = "test";
      try {
        const r = ensureVaultReadyForDistill(
          {
            contentPath: ro,
            configPath: path.join(ro, ".napkin"),
          },
          "fast",
        );
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

  // --- FB-2: HEAD-valid invariant ------------------------------------------
  //
  // `createDistillWorktree` runs `git worktree add ... HEAD`, which fails
  // with `fatal: invalid reference: HEAD` when the repo has no commits.
  // Auto-setup must NEVER leave the vault in a `.git` + empty state —
  // otherwise the FIRST auto-distill after session_start crashes. The
  // tests below pin each entry path.

  test("FB-2: existing empty repo, idempotent scaffolding — seeds empty commit so HEAD is valid", () => {
    // Setup: run `git init` in the vault, then pre-install our scaffolding
    // file with exact content — so mergeManagedBlock writes nothing and the
    // existing-repo commit branch is SKIPPED. This is the idempotent
    // re-run path on a vault that happens to have no commits yet. Pre-FB-2
    // this branch left HEAD unresolvable.
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    // Pre-populate .gitignore with our exact canonical block so the
    // scaffold is a no-op. PR #12: no `.gitattributes` to pre-populate
    // any more.
    fs.writeFileSync(path.join(vault, ".gitignore"), canonicalBlock());

    // Pre-condition: HEAD does not resolve (no commits).
    const beforeHead = git(vault, ["rev-parse", "--verify", "HEAD"]);
    expect(beforeHead.status).not.toBe(0);

    const r = runSetup();
    expect(r.error).toBeUndefined();
    expect(r.initialized).toBe(false);
    expect(r.scaffolded).toEqual([]); // nothing to scaffold
    expect(r.findings).toEqual([]);
    expect(r.seededCommit).toBe(true);

    // Post-condition: HEAD resolves — subsequent createDistillWorktree
    // won't explode.
    const afterHead = git(vault, ["rev-parse", "--verify", "HEAD"]);
    expect(afterHead.status).toBe(0);
  });

  test("FB-2: existing empty repo, new scaffolding — normal scaffold+commit path still works", () => {
    // Pre-FB-2 this path was fine: the scaffold-commit creates HEAD. We
    // pin it to make sure the FB-2 change doesn't accidentally double-
    // commit (scaffold commit + seeded empty commit).
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    // No pre-existing scaffolding — mergeManagedBlock will write `.gitignore`.

    const r = runSetup();
    expect(r.error).toBeUndefined();
    expect(r.initialized).toBe(false);
    expect(r.scaffolded).toEqual([".gitignore"]);
    expect(r.findings).toEqual([
      {
        kind: "auto-recovered",
        invariant: "gitignore-block-correct",
        message: expect.any(String),
        recovery: "installed",
      },
    ]);
    // The scaffold commit provides HEAD; no empty seed needed.
    expect(r.seededCommit).toBeUndefined();

    const log = git(vault, ["log", "--oneline"]).stdout.trim().split("\n");
    // Exactly one commit: the scaffold commit. No seeded-empty commit on
    // top of it.
    expect(log.length).toBe(1);
    expect(log[0]).toContain("napkin: scaffold auto-distill git config");
  });

  // --- legacy-embedded-layout refusal --------------------------------------
  //
  // Worktree-based concurrency relies on napkin's `findVault` resolving
  // cwd=worktree to the worktree itself. That only works for subdir-
  // layout vaults (where `configPath !== contentPath` because the branch
  // tracks a `.napkin/config.json`). Legacy embedded vaults have
  // `configPath === contentPath` and no `.napkin/` subdir in the branch;
  // distill writes would bypass the worktree silently. Auto-setup refuses
  // here so the session_start handler can surface a migration notify.

  test("legacy-embedded layout (configPath === contentPath) \u2192 refuses, returns legacyLayout", () => {
    // Legacy vault: config.json lives alongside notes at the vault root,
    // no `.napkin/` subdir. napkin resolves contentPath = configPath.
    const r = ensureVaultReadyForDistill(
      {
        contentPath: vault,
        configPath: vault,
      },
      "fast",
    );
    expect(r.error).toBe(LEGACY_EMBEDDED_LAYOUT_ERROR);
    expect(r.legacyLayout).toEqual({ configPath: vault });
    expect(r.initialized).toBe(false);
    expect(r.scaffolded).toEqual([]);
    expect(r.findings).toEqual([
      {
        kind: "error",
        invariant: "subdir-layout",
        message: expect.any(String),
      },
    ]);
    // Must not have attempted git init — no `.git` dir in the vault.
    expect(fs.existsSync(path.join(vault, ".git"))).toBe(false);
  });

  test("legacy-embedded layout refusal is atomic (does NOT write scaffolding files)", () => {
    // Belt-and-braces: we must not write .gitignore on a legacy vault
    // even if the caller later ignores the error. Otherwise a stale
    // `.gitignore` would be the only artifact the user sees after a
    // failed migration attempt.
    const r = ensureVaultReadyForDistill(
      {
        contentPath: vault,
        configPath: vault,
      },
      "fast",
    );
    expect(r.error).toBe(LEGACY_EMBEDDED_LAYOUT_ERROR);
    expect(fs.existsSync(path.join(vault, ".gitignore"))).toBe(false);
    expect(fs.existsSync(path.join(vault, ".gitattributes"))).toBe(false);
  });

  test("subdir layout (configPath distinct) bypasses the legacy check", () => {
    // Sanity contrast: when configPath is distinct from contentPath,
    // auto-setup proceeds normally (this is the normal happy path, pinned
    // so a refactor of the detection can't flip the polarity).
    const r = runSetup();
    expect(r.error).toBeUndefined();
    expect(r.legacyLayout).toBeUndefined();
  });

  test("on a healthy vault, both 'fast' and 'full' levels produce empty findings", () => {
    // Structural pin at the happy-path baseline. The two levels diverge
    // on the `config.json-tracked` invariant (full only); on a vault
    // where config.json is already tracked, both levels see no
    // outstanding work and return `findings: []`. Catches accidental
    // wiring-layer divergence (e.g. a stray finding firing at fast
    // level that was supposed to be full-only).
    fs.writeFileSync(path.join(vault, "f.md"), "# f\n");
    const fast = runSetup("fast");
    expect(fast.error).toBeUndefined();
    expect(fast.initialized).toBe(true);
    // First run initialises the repo and installs the managed block.
    expect(fast.findings).toEqual([
      {
        kind: "auto-recovered",
        invariant: "vault-is-git-repo",
        message: expect.any(String),
        recovery: "ran git init",
      },
      {
        kind: "auto-recovered",
        invariant: "gitignore-block-correct",
        message: expect.any(String),
        recovery: "installed",
      },
    ]);

    // Run again at full level on the now-set-up vault: idempotent.
    const full = runSetup("full");
    expect(full.error).toBeUndefined();
    expect(full.findings).toEqual([]);
    expect(full.initialized).toBe(false);
    expect(full.scaffolded).toEqual([]);
  });

  // --- managed-block format (Ansible-style markers) -----------------------
  //
  // The .gitignore is rewritten as a `# BEGIN NAPKIN-DISTILL MANAGED` /
  // `# END NAPKIN-DISTILL MANAGED` block. Drift inside the markers is
  // auto-recovered; user content outside the markers is byte-preserved;
  // malformed markers refuse auto-fix and surface a loud error.

  test("BLOCK_CONTENT is a strict superset of GITIGNORE_LINES (non-comment, non-blank)", () => {
    // Pin the contract from the v0.3.0 → v0.3.1 migration: every
    // line-by-line entry that 0.3.0 vaults relied on must be present in
    // the managed block. A future edit that drops one would break the
    // SEC-5 belt-and-braces protections silently; this assertion fails
    // loudly instead.
    const meaningful = (xs: readonly string[]) =>
      xs.map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
    const oldEntries = meaningful(GITIGNORE_LINES);
    const newEntries = new Set(meaningful(BLOCK_CONTENT));
    for (const entry of oldEntries) {
      expect(newEntries.has(entry)).toBe(true);
    }
  });

  test("v0.3.0-shaped line-by-line .gitignore migrates to managed block", () => {
    // RED: this is the migration scenario for vaults that were set up by
    // v0.3.0 (line-by-line append, no markers). After the run the file
    // must have the markers, canonical content inside, and zero orphan
    // lines outside.
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(
      path.join(vault, ".gitignore"),
      `${GITIGNORE_LINES.join("\n")}\n`,
    );
    git(vault, ["add", ".gitignore"]);
    git(vault, ["commit", "-q", "-m", "v0.3.0 line-by-line"]);

    const r = runSetup();
    expect(r.error).toBeUndefined();
    expect(r.scaffolded).toEqual([".gitignore"]);
    expect(r.findings).toEqual([
      {
        kind: "auto-recovered",
        invariant: "gitignore-block-correct",
        message: expect.any(String),
        recovery: "migrated from line-by-line",
      },
    ]);

    const gi = fs.readFileSync(path.join(vault, ".gitignore"), "utf-8");
    expect(gi).toContain(BLOCK_MARKER_BEGIN);
    expect(gi).toContain(BLOCK_MARKER_END);
    // No orphan canonical lines outside the markers.
    const begin = gi.indexOf(BLOCK_MARKER_BEGIN);
    const end = gi.indexOf(BLOCK_MARKER_END);
    const outside =
      gi.slice(0, begin) + gi.slice(end + BLOCK_MARKER_END.length);
    const canonicalNonComment = BLOCK_CONTENT.filter(
      (l) => l.trim().length > 0 && !l.startsWith("#"),
    );
    for (const line of canonicalNonComment) {
      expect(outside).not.toContain(line);
    }
  });

  test("managed block with a missing canonical line is reset in place", () => {
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    // Canonical block minus one line (`.napkin/distill/`). The drift
    // detector must spot the difference and rewrite the bracketed
    // region back to canonical.
    const drifted = canonicalBlock().replace(".napkin/distill/\n", "");
    fs.writeFileSync(path.join(vault, ".gitignore"), drifted);
    git(vault, ["add", ".gitignore"]);
    git(vault, ["commit", "-q", "-m", "drift"]);

    const r = runSetup();
    expect(r.error).toBeUndefined();
    expect(r.scaffolded).toEqual([".gitignore"]);
    expect(r.findings).toEqual([
      {
        kind: "auto-recovered",
        invariant: "gitignore-block-correct",
        message: expect.any(String),
        recovery: "reset",
      },
    ]);
    const gi = fs.readFileSync(path.join(vault, ".gitignore"), "utf-8");
    expect(gi).toContain(".napkin/distill/");
  });

  test("user content outside markers is preserved byte-identically on idempotent runs", () => {
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    // Mix user content above + below the canonical block. Run setup;
    // assert the file is byte-identical (idempotent path — nothing to do).
    const userBefore = "# user header\nnode_modules/\nbuild/\n\n";
    const userAfter = "\n# trailing user note\ncoverage/\n";
    const initial = `${userBefore}${canonicalBlock()}${userAfter}`;
    fs.writeFileSync(path.join(vault, ".gitignore"), initial);
    git(vault, ["add", ".gitignore"]);
    git(vault, ["commit", "-q", "-m", "mixed"]);

    const r = runSetup();
    expect(r.error).toBeUndefined();
    expect(r.scaffolded).toEqual([]);
    expect(r.findings).toEqual([]);

    const after = fs.readFileSync(path.join(vault, ".gitignore"), "utf-8");
    expect(after).toBe(initial);
  });

  test("BEGIN marker without matching END is malformed: error finding, file untouched", () => {
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    const original = `${BLOCK_MARKER_BEGIN}\n.napkin/distill/\n# missing END marker\n`;
    fs.writeFileSync(path.join(vault, ".gitignore"), original);
    git(vault, ["add", ".gitignore"]);
    git(vault, ["commit", "-q", "-m", "malformed"]);

    const r = runSetup();
    expect(r.error).toBeUndefined();
    expect(r.scaffolded).toEqual([]);
    expect(r.findings).toEqual([
      {
        kind: "error",
        invariant: "gitignore-block-correct",
        message: expect.stringContaining("malformed"),
      },
    ]);
    const after = fs.readFileSync(path.join(vault, ".gitignore"), "utf-8");
    expect(after).toBe(original);
  });

  test("multiple BEGIN markers are malformed: error finding, file untouched", () => {
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    const original = `${BLOCK_MARKER_BEGIN}\n.napkin/distill/\n${BLOCK_MARKER_END}\n${BLOCK_MARKER_BEGIN}\n.env\n${BLOCK_MARKER_END}\n`;
    fs.writeFileSync(path.join(vault, ".gitignore"), original);
    git(vault, ["add", ".gitignore"]);
    git(vault, ["commit", "-q", "-m", "two-blocks"]);

    const r = runSetup();
    expect(r.error).toBeUndefined();
    expect(r.scaffolded).toEqual([]);
    expect(r.findings).toEqual([
      {
        kind: "error",
        invariant: "gitignore-block-correct",
        message: expect.stringContaining("malformed"),
      },
    ]);
    const after = fs.readFileSync(path.join(vault, ".gitignore"), "utf-8");
    expect(after).toBe(original);
  });

  test("END marker before BEGIN marker is malformed: error finding, file untouched", () => {
    // The wellFormed predicate requires beginIndices[0] < endIndices[0].
    // A file where the END marker appears earlier in the file than the
    // BEGIN marker (e.g. a user shuffled the block) hits the malformed
    // branch even though the count of each marker is exactly 1.
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    const original = `${BLOCK_MARKER_END}\n.napkin/distill/\n${BLOCK_MARKER_BEGIN}\n`;
    fs.writeFileSync(path.join(vault, ".gitignore"), original);
    git(vault, ["add", ".gitignore"]);
    git(vault, ["commit", "-q", "-m", "end-before-begin"]);

    const r = runSetup();
    expect(r.error).toBeUndefined();
    expect(r.scaffolded).toEqual([]);
    expect(r.findings).toEqual([
      {
        kind: "error",
        invariant: "gitignore-block-correct",
        message: expect.stringContaining("malformed"),
      },
    ]);
    const after = fs.readFileSync(path.join(vault, ".gitignore"), "utf-8");
    expect(after).toBe(original);
  });

  test("END marker without any BEGIN is malformed: error finding, file untouched", () => {
    // markersAbsent is `beginIndices.length === 0 && endIndices.length
    // === 0`. An END marker on its own (zero BEGINs, one or more ENDs)
    // fails markersAbsent and the wellFormed-pair predicate, so it hits
    // the malformed branch instead of being silently ignored.
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    const original = `# user-only\n${BLOCK_MARKER_END}\nlogs/\n`;
    fs.writeFileSync(path.join(vault, ".gitignore"), original);
    git(vault, ["add", ".gitignore"]);
    git(vault, ["commit", "-q", "-m", "orphan-end"]);

    const r = runSetup();
    expect(r.error).toBeUndefined();
    expect(r.scaffolded).toEqual([]);
    expect(r.findings).toEqual([
      {
        kind: "error",
        invariant: "gitignore-block-correct",
        message: expect.stringContaining("malformed"),
      },
    ]);
    const after = fs.readFileSync(path.join(vault, ".gitignore"), "utf-8");
    expect(after).toBe(original);
  });

  test("asymmetric markers (2 BEGIN, 1 END) are malformed: error finding, file untouched", () => {
    // Distinct from the existing "multiple BEGIN markers" test (2 BEGIN
    // + 2 END = two complete blocks): here the marker counts disagree
    // (2 BEGIN + 1 END), which also fails the wellFormed predicate
    // (length === 1 on both sides) without being a complete-block
    // duplicate.
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    const original = `${BLOCK_MARKER_BEGIN}\n.napkin/distill/\n${BLOCK_MARKER_END}\n${BLOCK_MARKER_BEGIN}\n.env\n`;
    fs.writeFileSync(path.join(vault, ".gitignore"), original);
    git(vault, ["add", ".gitignore"]);
    git(vault, ["commit", "-q", "-m", "asymmetric markers"]);

    const r = runSetup();
    expect(r.error).toBeUndefined();
    expect(r.scaffolded).toEqual([]);
    expect(r.findings).toEqual([
      {
        kind: "error",
        invariant: "gitignore-block-correct",
        message: expect.stringContaining("malformed"),
      },
    ]);
    const after = fs.readFileSync(path.join(vault, ".gitignore"), "utf-8");
    expect(after).toBe(original);
  });

  test("unrelated user '# BEGIN ...' markers do not collide with detection", () => {
    // The marker match requires the exact `NAPKIN-DISTILL MANAGED`
    // suffix. A user marker like `# BEGIN MY-OWN-SECTION` must not be
    // matched as ours.
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    const userMarkered =
      "# BEGIN MY-OWN-SECTION\ncoverage/\n# END MY-OWN-SECTION\n";
    fs.writeFileSync(path.join(vault, ".gitignore"), userMarkered);
    git(vault, ["add", ".gitignore"]);
    git(vault, ["commit", "-q", "-m", "user markers"]);

    const r = runSetup();
    expect(r.error).toBeUndefined();
    expect(r.scaffolded).toEqual([".gitignore"]);
    expect(r.findings).toEqual([
      {
        kind: "auto-recovered",
        invariant: "gitignore-block-correct",
        message: expect.any(String),
        recovery: "installed",
      },
    ]);
    const after = fs.readFileSync(path.join(vault, ".gitignore"), "utf-8");
    expect(after).toContain("# BEGIN MY-OWN-SECTION");
    expect(after).toContain("# END MY-OWN-SECTION");
    expect(after).toContain(BLOCK_MARKER_BEGIN);
    expect(after).toContain(BLOCK_MARKER_END);
  });

  test("orphan canonical lines outside an already-correct block are removed", () => {
    // Partial migration shape: a previous run installed the block, but
    // the user (or a v0.3.0 stale fixture) has duplicated canonical
    // entries above the block. The block stays put; the orphans are
    // stripped on the next run.
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    const initial = `.napkin/distill/\n.env\n\n${canonicalBlock()}`;
    fs.writeFileSync(path.join(vault, ".gitignore"), initial);
    git(vault, ["add", ".gitignore"]);
    git(vault, ["commit", "-q", "-m", "partial migration"]);

    const r = runSetup();
    expect(r.error).toBeUndefined();
    expect(r.scaffolded).toEqual([".gitignore"]);
    expect(r.findings).toEqual([
      {
        kind: "auto-recovered",
        invariant: "gitignore-block-correct",
        message: expect.any(String),
        recovery: "migrated from line-by-line",
      },
    ]);
    const after = fs.readFileSync(path.join(vault, ".gitignore"), "utf-8");
    // Orphan lines above the block are gone.
    const begin = after.indexOf(BLOCK_MARKER_BEGIN);
    const before = after.slice(0, begin);
    expect(before).not.toContain(".napkin/distill/");
    expect(before).not.toContain(".env");
    // Block is still intact.
    expect(after).toContain(BLOCK_MARKER_BEGIN);
    expect(after).toContain(BLOCK_MARKER_END);
  });

  // --- config.json validity ----------------------------------------------
  //
  // The vault's config.json is the user's hand-edited (or napkin-
  // generated) source of truth for vault config. A parse failure means
  // later napkin operations will silently fall back to defaults or
  // crash; we surface a loud error so the user can fix the file.

  test("invalid JSON in config.json: error finding, no auto-recovery", () => {
    fs.mkdirSync(path.join(vault, ".napkin"), { recursive: true });
    fs.writeFileSync(
      path.join(vault, ".napkin", "config.json"),
      "{ this is not valid json",
    );
    fs.writeFileSync(path.join(vault, "notes.md"), "# n\n");

    const r = runSetup();
    expect(r.error).toBeUndefined();
    expect(r.findings).toContainEqual({
      kind: "error",
      invariant: "config.json-valid-json",
      message: expect.stringContaining("is not valid JSON"),
    });
    // The corrupt file is left in place — user must repair it.
    expect(
      fs.readFileSync(path.join(vault, ".napkin", "config.json"), "utf-8"),
    ).toBe("{ this is not valid json");
  });

  test("missing config.json: no config.json-valid-json finding (skip silently)", () => {
    // Subdir-layout vault with no config.json yet (the typical fresh-
    // setup state before `napkin init` runs). The valid-JSON check is
    // file-existence-gated so we don't false-positive on this.
    fs.writeFileSync(path.join(vault, "notes.md"), "# n\n");

    const r = runSetup();
    expect(r.error).toBeUndefined();
    for (const f of r.findings) {
      expect(f.invariant).not.toBe("config.json-valid-json");
    }
  });

  // --- config.json tracked (full-level only; closes Issue #14) ----------
  //
  // Distill worktrees are checked out via `git worktree add HEAD`, which
  // copies only tracked files. An untracked `.napkin/config.json` never
  // reaches the worktree, napkin's findVault falls back to legacy
  // embedded layout, and the distill agent reports `Empty vault`. The
  // full-level check stages the file via the existing scaffolded[]
  // commit branch.

  test("existing repo, .napkin/config.json untracked: full-level tracks it", () => {
    // RED for Issue #14. The fixture mirrors the reported scenario:
    // a user runs `napkin init` (creates .napkin/config.json) on a
    // git repo, but never `git add`s the file.
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(vault, "seed.md"), "# seed\n");
    git(vault, ["add", "seed.md"]);
    git(vault, ["commit", "-q", "-m", "seed"]);

    fs.mkdirSync(path.join(vault, ".napkin"), { recursive: true });
    fs.writeFileSync(
      path.join(vault, ".napkin", "config.json"),
      JSON.stringify({ vault: { root: ".." } }),
    );

    // Pre-condition: config.json is NOT tracked.
    const beforeLs = git(vault, [
      "ls-files",
      "--error-unmatch",
      ".napkin/config.json",
    ]);
    expect(beforeLs.status).not.toBe(0);

    const r = runSetup("full");
    expect(r.error).toBeUndefined();
    expect(r.scaffolded).toContain(".napkin/config.json");
    expect(r.findings).toContainEqual({
      kind: "auto-recovered",
      invariant: "config.json-tracked",
      message: expect.any(String),
      recovery: "git add .napkin/config.json",
    });

    // Post-condition: config.json is tracked.
    const afterLs = git(vault, [
      "ls-files",
      "--error-unmatch",
      ".napkin/config.json",
    ]);
    expect(afterLs.status).toBe(0);
  });

  test("config.json-tracked is idempotent on a re-run (no spurious recovery, no new commit)", () => {
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(vault, "seed.md"), "# seed\n");
    git(vault, ["add", "seed.md"]);
    git(vault, ["commit", "-q", "-m", "seed"]);

    fs.mkdirSync(path.join(vault, ".napkin"), { recursive: true });
    fs.writeFileSync(
      path.join(vault, ".napkin", "config.json"),
      JSON.stringify({ vault: { root: ".." } }),
    );

    runSetup("full");
    const headAfterFirst = git(vault, ["rev-parse", "HEAD"]).stdout.trim();

    const second = runSetup("full");
    expect(second.error).toBeUndefined();
    expect(second.scaffolded).toEqual([]);
    for (const f of second.findings) {
      expect(f.invariant).not.toBe("config.json-tracked");
    }

    const headAfterSecond = git(vault, ["rev-parse", "HEAD"]).stdout.trim();
    expect(headAfterSecond).toBe(headAfterFirst);
  });

  test("fast-level does NOT stage config.json even when it is untracked", () => {
    // The tracking check is full-level only. Fast-level (session_start)
    // must remain the cheapest necessary call — no git index probes
    // beyond `ls-files`-style commit gates that the existing fast lane
    // does not perform.
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(vault, "seed.md"), "# seed\n");
    git(vault, ["add", "seed.md"]);
    git(vault, ["commit", "-q", "-m", "seed"]);

    fs.mkdirSync(path.join(vault, ".napkin"), { recursive: true });
    fs.writeFileSync(
      path.join(vault, ".napkin", "config.json"),
      JSON.stringify({ vault: { root: ".." } }),
    );

    const r = runSetup("fast");
    expect(r.error).toBeUndefined();
    expect(r.scaffolded).not.toContain(".napkin/config.json");
    for (const f of r.findings) {
      expect(f.invariant).not.toBe("config.json-tracked");
    }

    // Confirm the file is still untracked after a fast-level call.
    const ls = git(vault, [
      "ls-files",
      "--error-unmatch",
      ".napkin/config.json",
    ]);
    expect(ls.status).not.toBe(0);
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
