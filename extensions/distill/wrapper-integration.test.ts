/**
 * Wrapper-owned integration (issue #122).
 *
 * Each test drives `distill-wrapper.sh` end-to-end against a step-7-contract
 * agent stub: the stub commits in the worktree and STOP, the wrapper owns
 * the catch-up, the read-only gate, the marker gate, the live-vault
 * preflight, the squash, the push and the cleanup.
 *
 * Red on the #121 head: the old wrapper never integrates a branch, so every
 * "landed" assertion fails (outcome `no-content`), and the old contract let
 * a stub that edits `area/prs/**` or commits markers reach the default
 * branch as `merged-content` (the design probes). Green after: the gates
 * judge the tree diff, not the commands the agent chose.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  makeWrapperScaffold,
  runWrapperWithStub,
  withNapkinOnPath,
} from "./_test-helpers";
import { findDistillOutcomeForBranch } from "./distill-workspace";

const FIXTURES_DIR = path.join(__dirname, "test-fixtures", "agent-stubs");

function fixturePath(name: string): string {
  const p = path.join(FIXTURES_DIR, name);
  if (!fs.existsSync(p)) {
    throw new Error(`fixture not found: ${p}`);
  }
  return p;
}

const makeScaffold = () => makeWrapperScaffold("napkin-distill-122-");

const GATED_GLOBS = "**/prs/**\n**/issues/**";

/** Run a git command in the scaffold vault and return trimmed stdout. */
function git(vault: string, args: string[]): string {
  return spawnSync("git", ["-C", vault, ...args], {
    encoding: "utf-8",
  }).stdout.trim();
}

/** Seed one file on the vault default branch and commit it. */
function seedVaultFile(vault: string, rel: string, content: string): void {
  const abs = path.join(vault, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  git(vault, ["add", "-A"]);
  git(vault, ["commit", "-q", "-m", `seed ${rel}`]);
}

/** Read the wrapper warning log for a branch, or "" when absent. */
function warningLog(errorDir: string, branch: string): string {
  const short = branch.replace(/^distill\//, "");
  const files = fs.existsSync(errorDir)
    ? fs
        .readdirSync(errorDir)
        .filter((f) => f.endsWith(`-${short}.warning.log`))
    : [];
  return files.length === 0
    ? ""
    : fs.readFileSync(path.join(errorDir, files[0]), "utf-8");
}

/** True when the distill branch still exists in the vault. */
function branchExists(vault: string, branch: string): boolean {
  const out = spawnSync("git", ["-C", vault, "branch", "--list", branch], {
    encoding: "utf-8",
  }).stdout.trim();
  return out.length > 0;
}

/** Stash count, so a test can prove the wrapper never stashed. */
function stashList(vault: string): string {
  return spawnSync("git", ["-C", vault, "stash", "list"], {
    encoding: "utf-8",
  }).stdout.trim();
}

/**
 * Configure a bare-repo origin for push tests. The vault main is pushed
 * with -u so origin/main exists at the seed sha.
 */
function setupOrigin(root: string, vault: string): string {
  const originPath = path.join(root, "origin.git");
  spawnSync("git", ["init", "--bare", "-b", "main", originPath]);
  spawnSync("git", ["-C", vault, "remote", "add", "origin", originPath]);
  spawnSync("git", ["-C", vault, "push", "-q", "-u", "origin", "main"]);
  return originPath;
}

/**
 * Advance origin/main from a separate clone, simulating a lane that pushed
 * while the distill ran. Returns the side commit sha.
 */
function advanceOrigin(root: string, originPath: string): string {
  const side = path.join(root, "side-clone");
  spawnSync("git", ["clone", "-q", originPath, side]);
  spawnSync("git", ["-C", side, "config", "user.email", "side@example.com"]);
  spawnSync("git", ["-C", side, "config", "user.name", "side"]);
  fs.writeFileSync(path.join(side, "side.md"), "# side\n");
  spawnSync("git", ["-C", side, "add", "-A"]);
  spawnSync("git", ["-C", side, "commit", "-q", "-m", "side: concurrent"]);
  spawnSync("git", ["-C", side, "push", "-q", "origin", "main"]);
  return git(side, ["rev-parse", "main"]);
}

describe("wrapper-owned integration (issue #122)", () => {
  let pathHandle: { restore: () => void };

  beforeEach(() => {
    pathHandle = withNapkinOnPath();
  });

  afterEach(() => {
    pathHandle.restore();
  });

  // Design case 1: read-only modify + create. The dropped change must be
  // parked as a patch and named in the warning log, and the rest of the
  // capture must still land.
  test("readonly-modify: PR-note edit is dropped, the new note lands, patch + warning kept", () => {
    const s = makeScaffold();
    try {
      const prNote = "---\ntype: pr\n---\n\n# PR 1\n\ninitial\n";
      seedVaultFile(s.vault, "area/prs/pr-1.md", prNote);
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("readonly-modify.sh"),
        extraEnv: { NAPKIN_DISTILL_READONLY: GATED_GLOBS },
      });

      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-content");
      // The read-only note is byte-identical to what main had before.
      expect(
        fs.readFileSync(path.join(s.vault, "area/prs/pr-1.md"), "utf-8"),
      ).toBe(prNote);
      // The ordinary note landed.
      expect(fs.existsSync(path.join(s.vault, "area/notes/new.md"))).toBe(true);
      // A warning names the dropped path, and the hunks are parked.
      const warned = warningLog(s.errorDir, r.branch);
      expect(warned).toContain("read-only path changed by the distill");
      expect(warned).toContain("area/prs/pr-1.md");
      const refusedDir = path.join(s.vault, ".napkin/distill/refused");
      // The wrapper made exactly one squash commit for the run.
      expect(git(s.vault, ["rev-list", "--count", `${r.preSha}..HEAD`])).toBe(
        "1",
      );
      const patches = fs.existsSync(refusedDir)
        ? fs.readdirSync(refusedDir)
        : [];
      expect(patches).toHaveLength(1);
      const patchBody = fs.readFileSync(
        path.join(refusedDir, patches[0]),
        "utf-8",
      );
      expect(patchBody).toContain("area/prs/pr-1.md");
      expect(patchBody).toContain("distill appended a finding about the PR");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // Design case 2: read-only create + delete.
  test("readonly-create-delete: a new PR note and a deleted issue note both stay out of main", () => {
    const s = makeScaffold();
    try {
      const issueNote = "# issue i\n\nopen\n";
      seedVaultFile(s.vault, "area/issues/i.md", issueNote);
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("readonly-create-delete.sh"),
        extraEnv: { NAPKIN_DISTILL_READONLY: GATED_GLOBS },
      });

      expect(r.exitCode).toBe(0);
      // Neither gated path appears in the landed diff.
      const changed = git(s.vault, [
        "diff",
        "--name-only",
        `${r.preSha}..HEAD`,
      ]);
      expect(changed).not.toContain("area/prs/new-pr.md");
      expect(changed).not.toContain("area/issues/i.md");
      expect(fs.existsSync(path.join(s.vault, "area/prs/new-pr.md"))).toBe(
        false,
      );
      expect(
        fs.readFileSync(path.join(s.vault, "area/issues/i.md"), "utf-8"),
      ).toBe(issueNote);
      expect(warningLog(s.errorDir, r.branch)).toContain("area/issues/i.md");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // Design case 3: a read-only write that only exists as a merge resolution.
  test("readonly-via-merge-resolution: resolving a conflict in the branch favour is still a write", () => {
    const s = makeScaffold();
    try {
      const prNote = "# PR 1\n\ninitial\n";
      seedVaultFile(s.vault, "area/prs/pr-1.md", prNote);
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("readonly-merge-resolution.sh"),
        extraEnv: { NAPKIN_DISTILL_READONLY: GATED_GLOBS },
      });

      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-content");
      const landed = fs.readFileSync(
        path.join(s.vault, "area/prs/pr-1.md"),
        "utf-8",
      );
      // Main concurrent lane line survives; the distill line does not.
      expect(landed).toContain("main: lane kept this line");
      expect(landed).not.toContain("distill rewrote this note");
      // And the run really landed: the wrapper squash commit carries the
      // agent first non-merge subject. Without this, the assertions above
      // pass on a wrapper that lands nothing (the pre-#122 behaviour).
      const subjects = git(s.vault, [
        "log",
        "--format=%s",
        `${r.preSha}..HEAD`,
      ]);
      expect(subjects).toContain("distill: pr note edit");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // Design case 4: committed conflict markers.
  test("markers-in-content: the run is refused, main does not move, the branch is kept", () => {
    const s = makeScaffold();
    try {
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("committed-markers.sh"),
      });

      expect(r.exitCode).toBe(1);
      expect(r.outcome).toBe("markers-in-content");
      // Nothing reached main.
      expect(git(s.vault, ["rev-parse", "main"])).toBe(r.preSha);
      expect(fs.existsSync(path.join(s.vault, "marked.md"))).toBe(false);
      // The branch survives as the forensic breadcrumb.
      expect(branchExists(s.vault, r.branch)).toBe(true);
      // The recovery hint names the branch and the inspection command.
      const parsed = findDistillOutcomeForBranch(
        s.errorDir,
        r.branch.replace(/^distill\//, ""),
      );
      expect(parsed?.recoveryHint ?? "").toContain(r.branch);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // Design case 5: another lane dirty copy of a touched path.
  test("dirty-live-path: defers instead of stashing, the dirty file is untouched", () => {
    const s = makeScaffold();
    try {
      seedVaultFile(s.vault, "notes/touched.md", "# note\n\nbase line\n");
      const dirty = "# note\n\nbase line\nlane edit not committed\n";
      fs.writeFileSync(path.join(s.vault, "notes/touched.md"), dirty);
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("note-change.sh"),
        extraEnv: { NAPKIN_STUB_NOTE: "notes/touched.md" },
      });

      expect(r.exitCode).toBe(1);
      expect(r.outcome).toBe("deferred-dirty");
      // Never stashed.
      expect(stashList(s.vault)).toBe("");
      // The lane edit is still there, byte-identical.
      expect(
        fs.readFileSync(path.join(s.vault, "notes/touched.md"), "utf-8"),
      ).toBe(dirty);
      // Nothing landed, and the branch was kept.
      expect(git(s.vault, ["rev-parse", "main"])).toBe(r.preSha);
      expect(branchExists(s.vault, r.branch)).toBe(true);
      expect(warningLog(s.errorDir, r.branch)).toContain(
        "deferring instead of stashing",
      );
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // Design case 6: a staged change from another lane must not be swept in.
  test("staged-not-swept: an unrelated staged change defers the run and stays staged", () => {
    const s = makeScaffold();
    try {
      seedVaultFile(s.vault, "notes/other.md", "# other\n");
      seedVaultFile(s.vault, "notes/touched.md", "# note\n\nbase line\n");
      fs.writeFileSync(
        path.join(s.vault, "notes/other.md"),
        "# other\n\nstaged lane edit\n",
      );
      git(s.vault, ["add", "notes/other.md"]);
      const stagedSha = git(s.vault, ["rev-parse", "main"]);
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("note-change.sh"),
        extraEnv: { NAPKIN_STUB_NOTE: "notes/touched.md" },
      });

      expect(r.exitCode).toBe(1);
      expect(r.outcome).toBe("deferred-dirty");
      // No distill commit exists, so nothing swept the staged file in.
      expect(git(s.vault, ["rev-parse", "main"])).toBe(stagedSha);
      const log = git(s.vault, ["log", "--format=%s", `${r.preSha}..HEAD`]);
      expect(log).not.toContain("distill:");
      // The staged change is still staged.
      expect(git(s.vault, ["diff", "--cached", "--name-only"])).toContain(
        "notes/other.md",
      );
      expect(branchExists(s.vault, r.branch)).toBe(true);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // Design case 7: main moved under the branch, on a daily note.
  test("main-moved race on a daily note: union merge lands both lines, no markers", () => {
    const s = makeScaffold();
    try {
      seedVaultFile(s.vault, "area/daily/2026-01-02.md", "# 2026-01-02\n\n");
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("daily-union-merge.sh"),
      });

      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-content");
      const landed = fs.readFileSync(
        path.join(s.vault, "area/daily/2026-01-02.md"),
        "utf-8",
      );
      expect(landed).toContain("distill: captured the session");
      expect(landed).toContain("lane: landed a review");
      expect(landed).not.toMatch(/^<{7} /m);
      expect(landed).not.toMatch(/^>{7} /m);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // Design case 8 (dirty tree half): a rejected push with another lane
  // tracked edit present must NOT pull and must NOT stash.
  test("push rejected with a dirty tree: merged-local, no pull, no stash", () => {
    const s = makeScaffold();
    try {
      seedVaultFile(s.vault, "notes/touched.md", "# note\n\nbase line\n");
      const originPath = setupOrigin(s.root, s.vault);
      const sideSha = advanceOrigin(s.root, originPath);
      // Another lane TRACKED edit, unrelated to the distill net change set.
      // It must be tracked: an untracked file cannot be damaged by a pull
      // (git refuses to overwrite it), so it does not block the recovery.
      seedVaultFile(s.vault, "notes/other.md", "# other\n\nbase\n");
      fs.writeFileSync(
        path.join(s.vault, "notes/other.md"),
        "# other\n\nlane edit\n",
      );
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("note-change.sh"),
        extraEnv: { NAPKIN_STUB_NOTE: "notes/touched.md" },
      });

      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-local");
      // No pull happened: the side commit is not in local history.
      expect(
        spawnSync("git", [
          "-C",
          s.vault,
          "merge-base",
          "--is-ancestor",
          sideSha,
          "main",
        ]).status,
      ).not.toBe(0);
      expect(stashList(s.vault)).toBe("");
      // The lane edit is still uncommitted and untouched.
      expect(
        fs.readFileSync(path.join(s.vault, "notes/other.md"), "utf-8"),
      ).toBe("# other\n\nlane edit\n");
      // Distill content is on local main, not on origin.
      expect(fs.existsSync(path.join(s.vault, "notes/touched.md"))).toBe(true);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // Design case 8 (clean tree half): the guarded pull is a MERGE, never a
  // rebase, even when the vault config says pull.rebase=true.
  test("push rejected with a clean tree: pull --no-rebase + push succeed (merged-content)", () => {
    const s = makeScaffold();
    try {
      seedVaultFile(s.vault, "notes/touched.md", "# note\n\nbase line\n");
      const originPath = setupOrigin(s.root, s.vault);
      const sideSha = advanceOrigin(s.root, originPath);
      // Prove --no-rebase wins over the user config.
      git(s.vault, ["config", "pull.rebase", "true"]);
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("note-change.sh"),
        extraEnv: { NAPKIN_STUB_NOTE: "notes/touched.md" },
      });

      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-content");
      expect(git(s.vault, ["rev-parse", "main"])).toBe(
        git(originPath, ["rev-parse", "main"]),
      );
      expect(
        spawnSync("git", [
          "-C",
          s.vault,
          "merge-base",
          "--is-ancestor",
          sideSha,
          "main",
        ]).status,
      ).toBe(0);
      // A merge commit exists in the window: the pull merged, not rebased.
      const mergeCount = git(s.vault, [
        "rev-list",
        "--merges",
        "--count",
        `${r.preSha}..HEAD`,
      ]);
      expect(Number(mergeCount)).toBeGreaterThanOrEqual(1);
      expect(stashList(s.vault)).toBe("");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });
});
