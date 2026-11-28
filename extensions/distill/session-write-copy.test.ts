/**
 * Unit tests for copySessionWritesToWorktree, the handoff that carries a
 * parent session's direct vault writes into the distill worktree before the
 * distill agent starts.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  copySessionWritesToWorktree,
  createDistillWorktree,
  generateDistillBranchName,
  removeDistillWorktree,
} from "./distill-workspace";

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (rc ${r.status}): ${r.stderr || r.stdout}`,
    );
  }
  return r.stdout.trim();
}

describe("copySessionWritesToWorktree", () => {
  let root: string;
  let vault: string;
  let worktree: string;
  let branch: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "session-write-copy-"));
    vault = path.join(root, "vault");
    worktree = path.join(root, "worktree");
    fs.mkdirSync(vault);
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "user.name", "test"]);
    git(vault, ["config", "user.email", "test@example.com"]);
    fs.writeFileSync(path.join(vault, "seed.md"), "# seed\n");
    fs.writeFileSync(path.join(vault, ".gitignore"), "ignored.md\n");
    git(vault, ["add", "-A"]);
    git(vault, ["commit", "-q", "-m", "seed"]);
    branch = generateDistillBranchName();
    createDistillWorktree(vault, branch, worktree);
  });

  afterEach(() => {
    removeDistillWorktree(vault, worktree, branch);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function copy(touchedFiles: readonly string[], parentCwd = vault) {
    return copySessionWritesToWorktree({
      vaultPath: vault,
      worktreePath: worktree,
      parentCwd,
      touchedFiles,
    });
  }

  test("copies an untracked vault note at the same relative path, copy-only", () => {
    const note = path.join(vault, "daily", "direct.md");
    fs.mkdirSync(path.dirname(note), { recursive: true });
    fs.writeFileSync(note, "# direct\n");

    const result = copy([note]);

    expect(result.copied).toEqual(["daily/direct.md"]);
    expect(result.skipped).toEqual([]);
    expect(result.autocommit).toMatch(/^[0-9a-f]{40}$/);
    expect(
      fs.readFileSync(path.join(worktree, "daily", "direct.md"), "utf-8"),
    ).toBe("# direct\n");
    // Copy-only: the shared checkout's own untracked file remains in place.
    expect(fs.readFileSync(note, "utf-8")).toBe("# direct\n");
    // Commit (a): exactly the session's paths, under the autocommit message.
    expect(git(worktree, ["log", "-1", "--format=%s"])).toBe(
      "autocommit: 1 file written by session unknown",
    );
    expect(
      git(worktree, ["show", "--name-only", "--format=", "HEAD"]).trim(),
    ).toBe("daily/direct.md");
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf-8"));
    expect(manifest.autocommit).toBe(result.autocommit);
    expect(manifest.paths).toEqual(["daily/direct.md"]);
  });

  test("copies a modified tracked vault file", () => {
    const seed = path.join(vault, "seed.md");
    fs.writeFileSync(seed, "# seed\n\nsession edit\n");

    const result = copy([seed]);

    expect(result.copied).toEqual(["seed.md"]);
    expect(fs.readFileSync(path.join(worktree, "seed.md"), "utf-8")).toBe(
      "# seed\n\nsession edit\n",
    );
  });

  test("relative touched paths resolve against the parent session cwd", () => {
    const note = path.join(vault, "relative.md");
    fs.writeFileSync(note, "# relative\n");

    const result = copy(["relative.md"], vault);

    expect(result.copied).toEqual(["relative.md"]);
    expect(fs.readFileSync(path.join(worktree, "relative.md"), "utf-8")).toBe(
      "# relative\n",
    );
  });

  test("skips files outside the vault", () => {
    const outside = path.join(root, "outside.md");
    fs.writeFileSync(outside, "# outside\n");

    const result = copy([outside]);

    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual([
      { path: outside, reason: "outside-vault" },
    ]);
    expect(fs.existsSync(path.join(worktree, "outside.md"))).toBe(false);
  });

  test("skips ignored vault files", () => {
    const ignored = path.join(vault, "ignored.md");
    fs.writeFileSync(ignored, "# ignored\n");

    const result = copy([ignored]);

    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual([{ path: "ignored.md", reason: "ignored" }]);
    expect(fs.existsSync(path.join(worktree, "ignored.md"))).toBe(false);
  });

  test("skips unmodified, missing, and non-file paths conservatively", () => {
    fs.mkdirSync(path.join(vault, "docs"));
    const result = copy([
      path.join(vault, "seed.md"),
      path.join(vault, "missing.md"),
      path.join(vault, "docs"),
    ]);

    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual([
      { path: "seed.md", reason: "unmodified" },
      { path: "missing.md", reason: "missing" },
      { path: "docs", reason: "not-a-file" },
    ]);
  });

  test("no copied writes: no autocommit is created and the manifest records null", () => {
    const result = copy([path.join(vault, "seed.md")]);

    expect(result.copied).toEqual([]);
    expect(result.autocommit).toBeNull();
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf-8"));
    expect(manifest.autocommit).toBeNull();
    expect(manifest.paths).toEqual([]);
    expect(git(worktree, ["log", "-1", "--format=%s"])).toBe("seed");
  });

  test("two parallel sessions autocommit only the files each one owns", () => {
    const noteA = path.join(vault, "session-a.md");
    const noteB = path.join(vault, "session-b.md");
    fs.writeFileSync(noteA, "# a\n");
    fs.writeFileSync(noteB, "# b\n");
    const worktreeB = path.join(root, "worktree-b");
    const branchB = generateDistillBranchName();
    createDistillWorktree(vault, branchB, worktreeB);
    try {
      const a = copySessionWritesToWorktree({
        vaultPath: vault,
        worktreePath: worktree,
        parentCwd: vault,
        touchedFiles: [noteA],
        sessionLabel: "sessiona",
      });
      const b = copySessionWritesToWorktree({
        vaultPath: vault,
        worktreePath: worktreeB,
        parentCwd: vault,
        touchedFiles: [noteB],
        sessionLabel: "sessionb",
      });

      expect(a.copied).toEqual(["session-a.md"]);
      expect(b.copied).toEqual(["session-b.md"]);
      expect(
        git(worktree, [
          "show",
          "--name-only",
          "--format=",
          a.autocommit as string,
        ]).trim(),
      ).toBe("session-a.md");
      expect(
        git(worktreeB, [
          "show",
          "--name-only",
          "--format=",
          b.autocommit as string,
        ]).trim(),
      ).toBe("session-b.md");
    } finally {
      removeDistillWorktree(vault, worktreeB, branchB);
    }
  });

  test("a session file the distill also edits keeps its original bytes in (a) and the edit in (b)", () => {
    const note = path.join(vault, "daily", "shared.md");
    fs.mkdirSync(path.dirname(note), { recursive: true });
    fs.writeFileSync(note, "# session original\n");
    const result = copy([note], vault);
    const autocommit = result.autocommit as string;
    expect(autocommit).toBeTruthy();

    // The distill agent edits the session-written file and does its own work.
    fs.appendFileSync(
      path.join(worktree, "daily", "shared.md"),
      "distill edit\n",
    );
    fs.writeFileSync(path.join(worktree, "distill-note.md"), "# distill\n");
    git(worktree, ["add", "-A", "--", ".", ":(exclude).napkin/distill/"]);
    git(worktree, ["commit", "-q", "-m", "wip: distill edits"]);

    // Documented rebuild: two linear commits on top of the base.
    const base = JSON.parse(fs.readFileSync(result.manifestPath, "utf-8")).base;
    git(worktree, ["reset", "--mixed", base]);
    git(worktree, ["reset", "-q", autocommit, "--", "daily/shared.md"]);
    git(worktree, [
      "commit",
      "-q",
      "-m",
      "autocommit: 1 file written by session unknown",
    ]);
    git(worktree, ["add", "-A", "--", ".", ":(exclude).napkin/distill/"]);
    git(worktree, ["commit", "-q", "-m", "distill: edit"]);

    const subjects = git(worktree, ["log", "-2", "--format=%s"]).split("\n");
    expect(subjects).toEqual([
      "distill: edit",
      "autocommit: 1 file written by session unknown",
    ]);
    // (a) carries the session's original bytes; (b) carries the edit on top.
    expect(git(worktree, ["show", `${autocommit}:daily/shared.md`])).toBe(
      "# session original",
    );
    expect(git(worktree, ["show", "HEAD:daily/shared.md"])).toBe(
      "# session original\ndistill edit",
    );
    expect(
      git(worktree, ["show", "--name-only", "--format=", "HEAD"]).trim(),
    ).toBe("daily/shared.md\ndistill-note.md");
  });

  test("deduplicates repeated writes to the same vault-relative path", () => {
    const note = path.join(vault, "dup.md");
    fs.writeFileSync(note, "# dup\n");

    const result = copy([note, "dup.md", note]);

    expect(result.copied).toEqual(["dup.md"]);
    expect(fs.readFileSync(path.join(worktree, "dup.md"), "utf-8")).toBe(
      "# dup\n",
    );
  });
});
