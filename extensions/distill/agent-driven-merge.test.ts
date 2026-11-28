/**
 * Integration tests against the formal bash-stub agent fixtures
 * (PR #12 Item C2).
 *
 * Each test drives the wrapper end-to-end with `NAPKIN_DISTILL_PI_BIN`
 * pointed at one of the fixtures under
 * `extensions/distill/test-fixtures/agent-stubs/`. The fixtures simulate
 * the 10 agent-behavior classes from the design's "Mocked-pi behaviors"
 * testing plan; this test file validates that the wrapper's full
 * pipeline (post-validation + salvage + outcome dispatch + sidecar
 * emission) handles each class correctly.
 *
 * Coverage relationship to existing inline-stub tests:
 *   - `wrapper-validation.test.ts` covers most validators in isolation
 *     (one-validator-per-test) using inline `writePiStub` patterns.
 *   - `wrapper-salvage.test.ts` covers the salvage path's sidecar
 *     contents for the four failed:* classes.
 *   - This file complements both with an integration view: the canonical
 *     fixture + full pipeline + outcome dispatch. It also fills genuine
 *     gaps in the inline-stub matrix:
 *       (a) `conflict-resolve-clean` \u2014 actual git-merge-with-conflict +
 *           agent resolves + squashes to default
 *       (b) `squash-skipped`         \u2014 agent commits to the worktree's
 *           distill branch but never squashes (vault HEAD doesn't move)
 *       (c) `multiple-commits-on-main` \u2014 agent makes 2+ commits on the
 *           default branch (validates the wrapper's `>= 1` commit-count
 *           dispatch)
 *       (d) `pushed-success`         \u2014 origin configured + agent pushes
 *           successfully (complements `merged-local` already covered
 *           in wrapper-validation.test.ts)
 *
 * Future v0.2.x cleanup may migrate the inline-stub patterns in the
 * other test files to call into these fixtures; for now both surfaces
 * coexist.
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

const makeScaffold = () => makeWrapperScaffold("napkin-distill-c2-");

/**
 * Configure a bare-repo origin for push-related tests. Returns the
 * origin path so callers can inspect post-push state. The vault's main
 * is `push -u`'ed to origin, so origin/main exists at the seed sha.
 */
function setupOriginForVault(scaffoldRoot: string, vault: string): string {
  const originPath = path.join(scaffoldRoot, "origin.git");
  spawnSync("git", ["init", "--bare", "-b", "main", originPath]);
  spawnSync("git", ["-C", vault, "remote", "add", "origin", originPath]);
  spawnSync("git", ["-C", vault, "push", "-u", "origin", "main"]);
  return originPath;
}

/**
 * Advance `origin/<default>` past the vault's local main by pushing a
 * commit from a separate clone. Used by the `push-fail-pull-merge-
 * success` fixture (CORR-1): simulates a teammate landing a commit
 * while the agent's distill ran, so the agent's first push fails
 * non-ff and the recovery flow (`pull --no-rebase` + push) is exercised.
 *
 * Leaves the side clone in `<scaffoldRoot>/side-clone` for forensic
 * inspection if the test fails. Returns the SHA of the side commit.
 */
function advanceOriginFromSideClone(
  scaffoldRoot: string,
  originPath: string,
  defaultBranch: string,
): string {
  const sideClone = path.join(scaffoldRoot, "side-clone");
  spawnSync("git", ["clone", "-q", originPath, sideClone]);
  spawnSync("git", [
    "-C",
    sideClone,
    "config",
    "user.email",
    "side@example.com",
  ]);
  spawnSync("git", ["-C", sideClone, "config", "user.name", "side"]);
  fs.writeFileSync(path.join(sideClone, "side.md"), "# side\n");
  spawnSync("git", ["-C", sideClone, "add", "."]);
  spawnSync("git", ["-C", sideClone, "commit", "-m", "side: concurrent edit"]);
  spawnSync("git", ["-C", sideClone, "push", "origin", defaultBranch]);
  const sha = spawnSync("git", ["-C", sideClone, "rev-parse", defaultBranch], {
    encoding: "utf-8",
  }).stdout.trim();
  return sha;
}

describe("agent-driven merge: integration against formal bash-stub fixtures (PR #12 C2)", () => {
  let pathHandle: { restore: () => void };

  beforeEach(() => {
    pathHandle = withNapkinOnPath();
  });

  afterEach(() => {
    pathHandle.restore();
  });

  // -------------------------------------------------------------------------
  // Behavior 1: clean-distill
  // -------------------------------------------------------------------------

  test("clean-distill fixture \u2192 merged-content", () => {
    const s = makeScaffold();
    try {
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("clean-distill.sh"),
      });
      expect(r.exitCode).toBe(0);
      // No origin in this scaffold: the legacy local path reports
      // merged-local; merged-content is reserved for a pushed commit.
      expect(r.outcome).toBe("merged-local");
      // Vault should have the agent's content committed.
      expect(fs.existsSync(path.join(s.vault, "distilled.md"))).toBe(true);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Behavior 2: conflict-resolve-clean
  //
  // Genuine gap fill: existing inline-stub tests don't simulate an
  // actual `git merge` with conflict + resolution. The fixture drives
  // the full integrate-and-squash flow.
  // -------------------------------------------------------------------------

  test("conflict-resolve-clean fixture \u2192 merged-local (resolved cleanly, no origin)", () => {
    const s = makeScaffold();
    try {
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("conflict-resolve-clean.sh"),
      });
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-local");
      // The resolved file must NOT contain conflict markers.
      const noteContent = fs.readFileSync(
        path.join(s.vault, "note.md"),
        "utf-8",
      );
      expect(noteContent).not.toMatch(/^<{7} /m);
      expect(noteContent).not.toMatch(/^={7}$/m);
      expect(noteContent).not.toMatch(/^>{7} /m);
      expect(noteContent).toContain("merged distill + main");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Behavior 3: conflict-leave-markers
  // -------------------------------------------------------------------------

  test("conflict-leave-markers fixture \u2192 failed:markers-after-agent-exit + recovery hint", () => {
    const s = makeScaffold();
    try {
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("conflict-leave-markers.sh"),
      });
      expect(r.exitCode).toBe(1);
      expect(r.outcome).toBe("failed:markers-after-agent-exit");

      const branchShort = r.branch.replace(/^distill\//, "");
      const parsed = findDistillOutcomeForBranch(s.errorDir, branchShort);
      expect(parsed?.outcomeClass).toBe("failed:markers-after-agent-exit");
      // Recovery hint now points the user at resolving the merge (not
      // `git revert` — the old marker-text scan's advice).
      expect(parsed?.recoveryHint).toMatch(/mergetool/);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Behavior 4: no-distill
  // -------------------------------------------------------------------------

  test("no-distill fixture \u2192 no-content", () => {
    const s = makeScaffold();
    try {
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("no-distill.sh"),
      });
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("no-content");
      // Vault main should be at startSha (no commits).
      const postSha = spawnSync("git", ["-C", s.vault, "rev-parse", "main"], {
        encoding: "utf-8",
      }).stdout.trim();
      expect(postSha).toBe(r.preSha);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Behavior 5: squash-skipped
  //
  // Genuine gap fill: existing inline-stub tests don't cover the case
  // where the agent commits to the worktree's distill branch but never
  // squashes back to default. From the vault's perspective this is
  // indistinguishable from `no-distill` (both leave default at startSha),
  // but the fixture documents the distinction for forensic clarity.
  //
  // Spec/impl alignment (CORR-3, Phase C R1 → Phase D D3): design.md
  // "Mocked-pi behaviors" #5 originally said `failed`, but the
  // implementation produces `no-content` (validate_commit_count == 0).
  // The impl is logically sound: from main's perspective no new
  // commits = no content. The orchestrator updates design.md post-
  // merge; this test pins the impl-side contract.
  // -------------------------------------------------------------------------

  test("squash-skipped fixture \u2192 no-content (default branch never moved)", () => {
    const s = makeScaffold();
    try {
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("squash-skipped.sh"),
      });
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("no-content");
      // Vault main should be at startSha.
      const postSha = spawnSync("git", ["-C", s.vault, "rev-parse", "main"], {
        encoding: "utf-8",
      }).stdout.trim();
      expect(postSha).toBe(r.preSha);
      // The dangling.md the agent wrote in the worktree shouldn't have
      // landed on default.
      expect(fs.existsSync(path.join(s.vault, "dangling.md"))).toBe(false);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Behavior 6: multiple-commits-on-main
  //
  // Genuine gap fill: the validate_commit_count dispatch is documented
  // as "0 \u2192 no-content / 1+ \u2192 has-content"; this test pins the 2-commit
  // case to keep the dispatch invariant locked.
  // -------------------------------------------------------------------------

  test("multiple-commits-on-main fixture -> merged-local (2 commits accepted, no squash warning)", () => {
    const s = makeScaffold();
    try {
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("multiple-commits-on-main.sh"),
      });
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-local");
      expect(fs.existsSync(path.join(s.vault, "first.md"))).toBe(true);
      expect(fs.existsSync(path.join(s.vault, "second.md"))).toBe(true);
      const count = spawnSync(
        "git",
        ["-C", s.vault, "rev-list", "--count", r.preSha + "..HEAD"],
        { encoding: "utf-8" },
      ).stdout.trim();
      expect(count).toBe("2");

      // Two commits are the expected no-origin shape (session autocommit +
      // distill commit), so the old squash-invariant warning must NOT fire.
      const branchShort = r.branch.replace(/^distill\//, "");
      const warningLogs = fs
        .readdirSync(s.errorDir)
        .filter((f) => f.endsWith("-" + branchShort + ".warning.log"));
      expect(warningLogs).toEqual([]);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Behavior 7: pushed-success (origin-first, worktree-only integration)
  // -------------------------------------------------------------------------

  test("pushed-success fixture (origin configured, agent pushes from the worktree) -> merged-content, checkout untouched", () => {
    const s = makeScaffold();
    try {
      const originPath = setupOriginForVault(s.root, s.vault);
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("pushed-success.sh"),
      });
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-content");
      // The commit landed on origin; the shared checkout was not the
      // integration scratchpad and stays exactly where it started.
      const originHasFile = spawnSync(
        "git",
        ["--git-dir", originPath, "cat-file", "-e", "main:pushed.md"],
        { encoding: "utf-8" },
      );
      expect(originHasFile.status).toBe(0);
      expect(
        spawnSync("git", ["-C", s.vault, "rev-parse", "main"], {
          encoding: "utf-8",
        }).stdout.trim(),
      ).toBe(r.preSha);
      expect(fs.existsSync(path.join(s.vault, "pushed.md"))).toBe(false);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("pushed-success with origin already advanced -> merged-content (origin merged in the worktree)", () => {
    const s = makeScaffold();
    try {
      const originPath = setupOriginForVault(s.root, s.vault);
      const sideSha = advanceOriginFromSideClone(s.root, originPath, "main");
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("pushed-success.sh"),
      });
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-content");
      // Both the concurrent origin commit and the distill content are on
      // origin/main; the side commit is an ancestor of the pushed tip.
      expect(
        spawnSync(
          "git",
          [
            "--git-dir",
            originPath,
            "merge-base",
            "--is-ancestor",
            sideSha,
            "main",
          ],
          { encoding: "utf-8" },
        ).status,
      ).toBe(0);
      expect(
        spawnSync(
          "git",
          ["--git-dir", originPath, "cat-file", "-e", "main:pushed.md"],
          {
            encoding: "utf-8",
          },
        ).status,
      ).toBe(0);
      expect(
        spawnSync("git", ["-C", s.vault, "rev-parse", "main"], {
          encoding: "utf-8",
        }).stdout.trim(),
      ).toBe(r.preSha);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Behavior 8: origin-integrated but never pushed
  //
  // The old fixture pair (push-fail-merged-local / push-fail-pull-merge-
  // success) encoded the deleted contract: squash in the shared checkout,
  // then "git pull --no-rebase" there. Both are replaced here by the
  // worktree-first fixture: a local commit with no push must fail loudly
  // with the dangling SHA, not warn.
  // -------------------------------------------------------------------------

  test("origin-integrate-no-push fixture (worktree commit, no push) -> failed:push-not-landed + dangling sha", () => {
    const s = makeScaffold();
    try {
      const originPath = setupOriginForVault(s.root, s.vault);
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("origin-integrate-no-push.sh"),
      });
      expect(r.exitCode).toBe(1);
      expect(r.outcome).toBe("failed:push-not-landed");

      const branchShort = r.branch.replace(/^distill\//, "");
      const parsed = findDistillOutcomeForBranch(s.errorDir, branchShort);
      expect(parsed?.outcomeClass).toBe("failed:push-not-landed");
      expect(parsed?.recoveryHint).toMatch(/Dangling commit: [0-9a-f]{40}/);

      const originHasFile = spawnSync(
        "git",
        ["--git-dir", originPath, "cat-file", "-e", "main:unpushed.md"],
        { encoding: "utf-8" },
      );
      expect(originHasFile.status).not.toBe(0);
      expect(
        spawnSync("git", ["-C", s.vault, "rev-parse", "main"], {
          encoding: "utf-8",
        }).stdout.trim(),
      ).toBe(r.preSha);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Behavior 9: agent-timeout
  // -------------------------------------------------------------------------

  test("agent-timeout fixture (sleeps past budget) \u2192 failed:agent-timeout + recovery hint", () => {
    const s = makeScaffold();
    try {
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("agent-timeout.sh"),
        maxDurationSecs: "1",
      });
      expect(r.exitCode).toBe(1);
      expect(r.outcome).toBe("failed:agent-timeout");

      const branchShort = r.branch.replace(/^distill\//, "");
      const parsed = findDistillOutcomeForBranch(s.errorDir, branchShort);
      expect(parsed?.outcomeClass).toBe("failed:agent-timeout");
      expect(parsed?.recoveryHint).toMatch(/maxDurationMinutes/);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Behavior 10: agent-crashes
  // -------------------------------------------------------------------------

  test("agent-crashes fixture (exits 7 with stderr) \u2192 failed:agent-exit-nonzero", () => {
    const s = makeScaffold();
    try {
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("agent-crashes.sh"),
      });
      expect(r.exitCode).toBe(1);
      expect(r.outcome).toBe("failed:agent-exit-nonzero");

      const branchShort = r.branch.replace(/^distill\//, "");
      const parsed = findDistillOutcomeForBranch(s.errorDir, branchShort);
      expect(parsed?.outcomeClass).toBe("failed:agent-exit-nonzero");
      expect(parsed?.recoveryHint).toMatch(/reflog/i);
      // The crash diagnostic from the fixture's stderr should be in the
      // wrapper's error log alongside the outcome sidecar. Inspect the
      // .log sibling.
      const logFiles = fs
        .readdirSync(s.errorDir)
        .filter((f) => f.endsWith(`-${branchShort}.log`));
      expect(logFiles.length).toBe(1);
      const logBody = fs.readFileSync(
        path.join(s.errorDir, logFiles[0]),
        "utf-8",
      );
      expect(logBody).toContain("simulated crash");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });
});
