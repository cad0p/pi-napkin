/**
 * vault-main-guard reference-transaction hook tests.
 *
 * The hook is the git-level enforcement for the shared-vault invariant
 * "local main never moves non-fast-forward and is never deleted". It covers
 * every tool and every session, unlike a steering rule which only sees pi's
 * own tool calls. These tests drive the shipped hook and installer against
 * real scratch repositories - no mocks - because the behavior under test IS
 * git's ref-transaction plumbing.
 *
 * Covered matrix (from the incident in
 * personal/github/pi-napkin/debugging/2026-11-05-vault-main-drops-unpushed-commits):
 *   pass:   commit, fast-forward merge, merge commit, pull --no-rebase,
 *           fast-forward update-ref, initial creation of main
 *   refuse: update-ref to a non-descendant, branch -f, checkout -B,
 *           reset --hard to an older tip, a rebase rewrite, branch -D main,
 *           any of the above from a linked worktree
 *   install: chaining an existing reference-transaction hook (stdin is
 *           replayed from a buffer), core.hooksPath, reinstall, dry-run,
 *           git-lfs hooks untouched and still working
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { VAULT_MAIN_GUARD_INSTALLER } from "./scripts-paths";

const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: "utf-8",
    env: { ...process.env, ...IDENTITY_ENV, ...opts.env },
  });
}

function git(
  repo: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv } = {},
): ReturnType<typeof spawnSync> {
  return run("git", ["-C", repo, ...args], opts);
}

function gitOk(
  repo: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv } = {},
): string {
  const r = git(repo, args, opts);
  if (r.status !== 0) {
    throw new Error(`git -C ${repo} ${args.join(" ")} failed: ${r.stderr}`);
  }
  return (r.stdout ?? "").trim();
}

function initRepo(dir: string, branch = "main"): string {
  fs.mkdirSync(dir, { recursive: true });
  const r = run("git", ["init", "-q", "-b", branch, dir]);
  if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);
  gitOk(dir, ["config", "user.email", "test@example.com"]);
  gitOk(dir, ["config", "user.name", "test"]);
  gitOk(dir, ["config", "commit.gpgsign", "false"]);
  gitOk(dir, ["commit", "-q", "--allow-empty", "-m", "seed"]);
  return dir;
}

function install(
  repo: string,
  args: string[] = [],
): ReturnType<typeof spawnSync> {
  return run("sh", [VAULT_MAIN_GUARD_INSTALLER, "--repo", repo, ...args]);
}

/** Bare origin plus clones a and b, each with a seed commit on main. */
function makeClonePair(root: string, name: string) {
  const base = path.join(root, name);
  const origin = path.join(base, "origin");
  run("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const a = path.join(base, "a");
  const b = path.join(base, "b");
  run("git", ["clone", "-q", origin, a]);
  run("git", ["clone", "-q", origin, b]);
  for (const repo of [a, b])
    gitOk(repo, ["config", "user.email", "test@example.com"]);
  for (const repo of [a, b]) gitOk(repo, ["config", "user.name", "test"]);
  gitOk(a, ["commit", "-q", "--allow-empty", "-m", "seed"]);
  gitOk(a, ["push", "-q", "origin", "main"]);
  gitOk(b, ["pull", "-q", "--no-rebase", "origin", "main"]);
  return { base, origin, a, b };
}

function hasGitLfs(): boolean {
  const r = run("git", ["lfs", "version"]);
  return r.status === 0;
}

describe("vault-main-guard hook: allowed moves", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-napkin-vmg-pass-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("commit, fast-forward merge and merge commit pass", () => {
    const repo = initRepo(path.join(root, "repo"));
    expect(install(repo).status).toBe(0);

    fs.writeFileSync(path.join(repo, "one.txt"), "one\n");
    gitOk(repo, ["add", "one.txt"]);
    expect(git(repo, ["commit", "-q", "-m", "one"]).status).toBe(0);

    gitOk(repo, ["checkout", "-q", "-b", "ff-side"]);
    fs.writeFileSync(path.join(repo, "two.txt"), "two\n");
    gitOk(repo, ["add", "two.txt"]);
    gitOk(repo, ["commit", "-q", "-m", "two"]);
    gitOk(repo, ["checkout", "-q", "main"]);
    expect(git(repo, ["merge", "-q", "--ff-only", "ff-side"]).status).toBe(0);

    gitOk(repo, ["checkout", "-q", "-b", "merge-side", "HEAD~2"]);
    fs.writeFileSync(path.join(repo, "three.txt"), "three\n");
    gitOk(repo, ["add", "three.txt"]);
    gitOk(repo, ["commit", "-q", "-m", "three"]);
    gitOk(repo, ["checkout", "-q", "main"]);
    expect(git(repo, ["merge", "-q", "--no-edit", "merge-side"]).status).toBe(
      0,
    );
  });

  test("accepts a plain fast-forward plumbing write", () => {
    const repo = initRepo(path.join(root, "repo"));
    expect(install(repo).status).toBe(0);
    const before = gitOk(repo, ["rev-parse", "main"]);
    const desc = gitOk(repo, [
      "commit-tree",
      "HEAD^{tree}",
      "-p",
      before,
      "-m",
      "desc",
    ]);
    expect(git(repo, ["update-ref", "refs/heads/main", desc]).status).toBe(0);
    expect(gitOk(repo, ["rev-parse", "main"])).toBe(desc);
  });

  test("allows the initial creation of main", () => {
    const repo = initRepo(path.join(root, "fresh"), "dev");
    expect(install(repo).status).toBe(0);
    const seed = gitOk(repo, ["rev-parse", "HEAD"]);
    expect(git(repo, ["update-ref", "refs/heads/main", seed]).status).toBe(0);
    expect(gitOk(repo, ["rev-parse", "main"])).toBe(seed);
  });

  test("pull --no-rebase passes (fast-forward and merge shapes)", () => {
    const { a, b } = makeClonePair(root, "pull");
    expect(install(b).status).toBe(0);

    fs.writeFileSync(path.join(a, "remote.txt"), "remote\n");
    gitOk(a, ["add", "remote.txt"]);
    gitOk(a, ["commit", "-q", "-m", "remote"]);
    gitOk(a, ["push", "-q", "origin", "main"]);
    expect(git(b, ["pull", "-q", "--no-rebase", "origin", "main"]).status).toBe(
      0,
    );

    fs.writeFileSync(path.join(b, "local.txt"), "local\n");
    gitOk(b, ["add", "local.txt"]);
    gitOk(b, ["commit", "-q", "-m", "local"]);
    fs.writeFileSync(path.join(a, "remote2.txt"), "remote2\n");
    gitOk(a, ["add", "remote2.txt"]);
    gitOk(a, ["commit", "-q", "-m", "remote2"]);
    gitOk(a, ["push", "-q", "origin", "main"]);
    expect(git(b, ["pull", "-q", "--no-rebase", "origin", "main"]).status).toBe(
      0,
    );
  });
});

describe("vault-main-guard hook: refused moves", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-napkin-vmg-refuse-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function assertRefused(res: ReturnType<typeof spawnSync>): void {
    expect(res.status).not.toBe(0);
    expect(String(res.stderr)).toContain("vault-main-guard");
  }

  test("refuses update-ref to a non-descendant and leaves main unchanged", () => {
    const repo = initRepo(path.join(root, "repo"));
    expect(install(repo).status).toBe(0);
    const before = gitOk(repo, ["rev-parse", "main"]);
    // Dangling commit with no parent: nothing that descends from main.
    const alien = gitOk(repo, ["commit-tree", "HEAD^{tree}", "-m", "alien"]);
    const res = git(repo, ["update-ref", "refs/heads/main", alien]);
    assertRefused(res);
    expect(String(res.stderr)).toContain("git merge <source>");
    expect(gitOk(repo, ["rev-parse", "main"])).toBe(before);
  });

  test("refuses branch -f, checkout -B and reset --hard to an older tip", () => {
    const repo = initRepo(path.join(root, "repo"));
    expect(install(repo).status).toBe(0);
    gitOk(repo, ["commit", "-q", "--allow-empty", "-m", "two"]);
    gitOk(repo, ["commit", "-q", "--allow-empty", "-m", "three"]);
    const tip = gitOk(repo, ["rev-parse", "main"]);
    const older = gitOk(repo, ["rev-parse", "main~1"]);

    gitOk(repo, ["checkout", "-q", "-b", "side"]);
    assertRefused(git(repo, ["branch", "-f", "main", older]));
    assertRefused(git(repo, ["checkout", "-B", "main", older]));
    gitOk(repo, ["checkout", "-q", "main"]);
    assertRefused(git(repo, ["reset", "-q", "--hard", older]));
    expect(gitOk(repo, ["rev-parse", "main"])).toBe(tip);
  });

  test("refuses branch -D main", () => {
    const repo = initRepo(path.join(root, "repo"));
    expect(install(repo).status).toBe(0);
    const tip = gitOk(repo, ["rev-parse", "main"]);
    gitOk(repo, ["checkout", "-q", "-b", "side"]);
    const res = git(repo, ["branch", "-D", "main"]);
    assertRefused(res);
    expect(String(res.stderr)).toContain("refusing to delete");
    expect(gitOk(repo, ["rev-parse", "main"])).toBe(tip);
  });

  test("refuses a rebase that rewrites local main history", () => {
    const { a, b } = makeClonePair(root, "rebase");
    expect(install(b).status).toBe(0);
    fs.writeFileSync(path.join(b, "local.txt"), "local\n");
    gitOk(b, ["add", "local.txt"]);
    gitOk(b, ["commit", "-q", "-m", "local"]);
    const before = gitOk(b, ["rev-parse", "main"]);
    fs.writeFileSync(path.join(a, "remote.txt"), "remote\n");
    gitOk(a, ["add", "remote.txt"]);
    gitOk(a, ["commit", "-q", "-m", "remote"]);
    gitOk(a, ["push", "-q", "origin", "main"]);

    const res = git(b, [
      "-c",
      "pull.rebase=true",
      "pull",
      "--rebase",
      "origin",
      "main",
    ]);
    assertRefused(res);
    expect(gitOk(b, ["rev-parse", "main"])).toBe(before);
  });

  test("refuses non-fast-forward writes from a linked worktree", () => {
    const repo = initRepo(path.join(root, "repo"));
    expect(install(repo).status).toBe(0);
    const before = gitOk(repo, ["rev-parse", "main"]);
    const alien = gitOk(repo, ["commit-tree", "HEAD^{tree}", "-m", "alien"]);
    const wt = path.join(root, "wt");
    gitOk(repo, ["worktree", "add", "-q", wt, "-b", "wt-branch"]);
    assertRefused(git(wt, ["update-ref", "refs/heads/main", alien]));
    expect(gitOk(repo, ["rev-parse", "main"])).toBe(before);
  });
});

describe("vault-main-guard installer", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-napkin-vmg-install-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("chains an existing reference-transaction hook and replays its stdin", () => {
    const repo = initRepo(path.join(root, "repo"));
    const hooks = path.join(repo, ".git", "hooks");
    const logPath = path.join(root, "old-hook.log");
    fs.writeFileSync(
      path.join(hooks, "reference-transaction"),
      [
        "#!/bin/sh",
        `printf '%s\\n' "$1" >> "$GUARD_TEST_LOG"`,
        `while read -r old new ref; do printf '%s %s %s\\n' "$old" "$new" "$ref" >> "$GUARD_TEST_LOG"; done`,
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const res = install(repo);
    expect(res.status).toBe(0);
    expect(
      fs.existsSync(
        path.join(hooks, "reference-transaction.pre-vault-main-guard"),
      ),
    ).toBe(true);

    const before = gitOk(repo, ["rev-parse", "main"]);
    const alien = gitOk(repo, ["commit-tree", "HEAD^{tree}", "-m", "alien"]);
    const update = git(repo, ["update-ref", "refs/heads/main", alien], {
      env: { GUARD_TEST_LOG: logPath },
    });
    expect(update.status).not.toBe(0);
    expect(String(update.stderr)).toContain("vault-main-guard");
    expect(gitOk(repo, ["rev-parse", "main"])).toBe(before);

    const log = fs.readFileSync(logPath, "utf-8");
    expect(log).toContain("prepared");
    expect(log).toContain("refs/heads/main");

    // Reinstall keeps the chain (does not overwrite the backup).
    expect(install(repo).status).toBe(0);
    expect(
      fs.readFileSync(path.join(hooks, "reference-transaction"), "utf-8"),
    ).toContain("reference-transaction.pre-vault-main-guard");
  });

  test("installs into core.hooksPath when configured", () => {
    const repo = initRepo(path.join(root, "repo"));
    gitOk(repo, ["config", "core.hooksPath", ".githooks"]);
    expect(install(repo).status).toBe(0);
    expect(
      fs.existsSync(path.join(repo, ".githooks", "reference-transaction")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(repo, ".git", "hooks", "reference-transaction")),
    ).toBe(false);

    const before = gitOk(repo, ["rev-parse", "main"]);
    const alien = gitOk(repo, ["commit-tree", "HEAD^{tree}", "-m", "alien"]);
    expect(git(repo, ["update-ref", "refs/heads/main", alien]).status).not.toBe(
      0,
    );
    expect(gitOk(repo, ["rev-parse", "main"])).toBe(before);
  });

  test("--dry-run reports the target and changes nothing", () => {
    const repo = initRepo(path.join(root, "repo"));
    const res = install(repo, ["--dry-run"]);
    expect(res.status).toBe(0);
    expect(String(res.stdout)).toContain("hooks dir:");
    expect(String(res.stdout)).toContain("dry run");
    expect(
      fs.existsSync(path.join(repo, ".git", "hooks", "reference-transaction")),
    ).toBe(false);
  });

  test.skipIf(!hasGitLfs())(
    "leaves git-lfs hooks intact and lfs still works",
    () => {
      const repo = initRepo(path.join(root, "repo"));
      gitOk(repo, ["lfs", "install"]);
      gitOk(repo, ["lfs", "track", "*.bin"]);
      fs.writeFileSync(path.join(repo, "x.bin"), "BIN");
      gitOk(repo, ["add", ".gitattributes", "x.bin"]);
      gitOk(repo, ["commit", "-q", "-m", "lfs"]);

      expect(install(repo).status).toBe(0);
      for (const hook of [
        "post-checkout",
        "post-commit",
        "post-merge",
        "pre-push",
      ]) {
        expect(fs.existsSync(path.join(repo, ".git", "hooks", hook))).toBe(
          true,
        );
      }

      fs.writeFileSync(path.join(repo, "y.bin"), "MORE");
      gitOk(repo, ["add", "y.bin"]);
      expect(git(repo, ["commit", "-q", "-m", "lfs2"]).status).toBe(0);
      expect(
        git(repo, ["checkout", "-q", "-b", "lfs-side", "HEAD~1"]).status,
      ).toBe(0);
      expect(git(repo, ["checkout", "-q", "main"]).status).toBe(0);
      expect(gitOk(repo, ["lfs", "ls-files"])).toContain("x.bin");
    },
  );
});
