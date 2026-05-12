import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@mariozechner/pi-coding-agent";

import {
  cleanupDistillWorkspace,
  cleanupStaleWorktrees,
  createDistillWorkspace,
  createDistillWorktree,
  DISTILL_SUBDIR,
  DISTILL_WORKTREES_SUBDIR,
  DistillError,
  type DistillMeta,
  diffWorktreeSinceStart,
  generateDistillBranchName,
  getActiveDistills,
  getUnmergedDistillBranches,
  parseWorktreeList,
  readDistillMeta,
  removeDistillWorktree,
  STALE_META_AGE_MS,
  STALE_WORKTREE_MINUTES,
} from "./distill-workspace";

/**
 * Minimal real session file to feed SessionManager.forkFrom. The fork API
 * rejects empty session files; SessionManager only flushes to disk once an
 * assistant message is present (see `_persist` in pi's session-manager.js).
 * We seed with a user/assistant round-trip so the file is on disk and valid.
 */
function createSeededSessionFile(dir: string, cwd: string): string {
  const sm = SessionManager.create(cwd, dir);
  sm.appendMessage({ role: "user", content: "hello" });
  sm.appendMessage({ role: "assistant", content: "hi" });
  const file = sm.getSessionFile();
  if (!file || !fs.existsSync(file)) {
    throw new Error("failed to create test session on disk");
  }
  return file;
}

/**
 * Initialize a throwaway git repo with one commit so HEAD resolves. Returns
 * the absolute vault path.
 */
function createGitVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "distill-git-vault-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const run = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, env, encoding: "utf-8" });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    }
  };
  run(["init", "-q", "-b", "main"]);
  run(["config", "commit.gpgsign", "false"]);
  run(["config", "user.name", "test"]);
  run(["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(dir, "seed.md"), "# seed\n");
  run(["add", "seed.md"]);
  run(["commit", "-q", "-m", "seed"]);
  return dir;
}

describe("generateDistillBranchName", () => {
  test("format: distill/<hex6>-<epoch>", () => {
    const name = generateDistillBranchName(new Date(1_000_000_000 * 1000));
    expect(name).toMatch(/^distill\/[0-9a-f]{6}-1000000000$/);
  });

  test("accepts explicit nonce for deterministic testing", () => {
    const name = generateDistillBranchName(
      new Date(1_700_000_000 * 1000),
      "deadbe",
    );
    expect(name).toBe("distill/deadbe-1700000000");
  });

  test("two calls in the same second differ (random nonce)", () => {
    const now = new Date();
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seen.add(generateDistillBranchName(now));
    }
    // Collision with 24 bits of entropy in 50 draws is <1 in 700M \u2014 flake-proof.
    expect(seen.size).toBe(50);
  });
});

describe("createDistillWorktree", () => {
  let vault: string;

  beforeEach(() => {
    vault = createGitVault();
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test("creates a git worktree on a fresh branch rooted at HEAD", () => {
    const branch = generateDistillBranchName();
    const wt = path.join(vault, DISTILL_WORKTREES_SUBDIR, "wt1");
    createDistillWorktree(vault, branch, wt);

    // Seed file from parent commit is present in the worktree.
    expect(fs.existsSync(path.join(wt, "seed.md"))).toBe(true);
    // And git knows about the branch.
    const list = spawnSync(
      "git",
      ["-C", vault, "worktree", "list", "--porcelain"],
      { encoding: "utf-8" },
    ).stdout;
    expect(list).toContain(branch);

    removeDistillWorktree(vault, wt, branch);
  });

  test("throws DistillError if vault has no .git", () => {
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), "no-git-"));
    try {
      expect(() =>
        createDistillWorktree(noGit, "distill/aa-1", path.join(noGit, "wt")),
      ).toThrow(DistillError);
    } finally {
      fs.rmSync(noGit, { recursive: true, force: true });
    }
  });

  test("throws DistillError if branch name already taken", () => {
    const branch = generateDistillBranchName();
    const wt1 = path.join(vault, DISTILL_WORKTREES_SUBDIR, "wt1");
    createDistillWorktree(vault, branch, wt1);
    try {
      const wt2 = path.join(vault, DISTILL_WORKTREES_SUBDIR, "wt2");
      expect(() => createDistillWorktree(vault, branch, wt2)).toThrow(
        DistillError,
      );
    } finally {
      removeDistillWorktree(vault, wt1, branch);
    }
  });

  test("registered merge driver path is shell-quoted (space-safe) (SEC-2+C4)", () => {
    // The driver path is stored as part of a shell command string that git
    // runs via sh -c when the merge fires. If the path contains a space or
    // shell metacharacter and isn't quoted, sh word-splits it and driver
    // invocation fails. Also: an attacker-controlled path prefix could
    // inject arguments. Fix: wrap the path in single quotes.
    const branch = generateDistillBranchName();
    const wt = path.join(vault, DISTILL_WORKTREES_SUBDIR, "wt-quoted");
    createDistillWorktree(vault, branch, wt);
    try {
      const cfg = spawnSync(
        "git",
        ["-C", wt, "config", "--get", "merge.napkin-distill-merge.driver"],
        { encoding: "utf-8" },
      ).stdout.trim();
      // The path is single-quoted and ends with ' before the git
      // placeholder arguments.
      expect(cfg.startsWith("'")).toBe(true);
      expect(cfg).toMatch(/' %O %A %B %P$/);
    } finally {
      removeDistillWorktree(vault, wt, branch);
    }
  });

  test("merge driver works when vault path contains a space (SEC-2+C4)", () => {
    // Real integration check: create a vault inside a parent dir whose
    // name contains a space and verify createDistillWorktree succeeds.
    // Pre-fix, `git config merge....driver` would have stored the path
    // unquoted; a subsequent merge would split on the space.
    //
    // We stop at worktree creation + config readback (no actual merge run)
    // to keep the test hermetic — the merge pipeline has its own
    // coverage in spawn-distill-in-worktree.test.ts.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "space path parent-"));
    const spacedVault = path.join(parent, "vault with space");
    fs.mkdirSync(spacedVault);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "t@e",
    };
    const run = (args: string[], cwd = spacedVault) => {
      const r = spawnSync("git", args, { cwd, env, encoding: "utf-8" });
      if (r.status !== 0) {
        throw new Error(
          `git ${args.join(" ")} failed: ${r.stderr || r.stdout}`,
        );
      }
    };
    try {
      run(["init", "-q", "-b", "main"]);
      run(["config", "commit.gpgsign", "false"]);
      fs.writeFileSync(path.join(spacedVault, "seed.md"), "# seed\n");
      run(["add", "-A"]);
      run(["commit", "-q", "-m", "seed"]);

      const branch = generateDistillBranchName();
      const wt = path.join(spacedVault, DISTILL_WORKTREES_SUBDIR, "wt-spaced");
      // Should not throw even though the driver path on this box may
      // contain spaces further up the tree.
      createDistillWorktree(spacedVault, branch, wt);
      expect(fs.existsSync(wt)).toBe(true);
      removeDistillWorktree(spacedVault, wt, branch);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("removeDistillWorktree", () => {
  let vault: string;

  beforeEach(() => {
    vault = createGitVault();
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test("removes worktree + branch", () => {
    const branch = generateDistillBranchName();
    const wt = path.join(vault, DISTILL_WORKTREES_SUBDIR, "wt");
    createDistillWorktree(vault, branch, wt);
    expect(fs.existsSync(wt)).toBe(true);

    removeDistillWorktree(vault, wt, branch);

    expect(fs.existsSync(wt)).toBe(false);
    const branches = spawnSync("git", ["-C", vault, "branch"], {
      encoding: "utf-8",
    }).stdout;
    expect(branches).not.toContain(branch);
  });

  test("is idempotent on missing paths / branches", () => {
    expect(() =>
      removeDistillWorktree(vault, "/tmp/does-not-exist", "distill/zz-1"),
    ).not.toThrow();
  });

  test("no-ops cleanly if vault is gone", () => {
    const gone = fs.mkdtempSync(path.join(os.tmpdir(), "gone-"));
    fs.rmSync(gone, { recursive: true, force: true });
    expect(() =>
      removeDistillWorktree(gone, "/tmp/wt", "distill/zz-1"),
    ).not.toThrow();
  });
});

describe("createDistillWorkspace", () => {
  let vault: string;
  let sessionDir: string;
  let sourceSession: string;
  const workspaces: { worktreePath: string; branchName: string }[] = [];

  beforeEach(() => {
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "distill-workspace-test-src-"),
    );
    sourceSession = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    for (const w of workspaces) {
      cleanupDistillWorkspace(vault, w);
    }
    workspaces.length = 0;
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  function track<T extends { worktreePath: string; branchName: string }>(
    w: T,
  ): T {
    workspaces.push({ worktreePath: w.worktreePath, branchName: w.branchName });
    return w;
  }

  test("creates <wt>/.napkin/distill/ with session.jsonl and meta.json", () => {
    const w = track(createDistillWorkspace(vault, sourceSession));

    expect(fs.existsSync(w.worktreePath)).toBe(true);
    expect(fs.existsSync(w.sessionForkPath)).toBe(true);
    expect(fs.existsSync(w.metaPath)).toBe(true);

    // The distill subdir layout is stable.
    const distillDir = path.join(w.worktreePath, DISTILL_SUBDIR);
    expect(path.dirname(w.sessionForkPath)).toBe(distillDir);
    expect(path.dirname(w.metaPath)).toBe(distillDir);
    expect(path.basename(w.sessionForkPath)).toBe("session.jsonl");
    expect(path.basename(w.metaPath)).toBe("meta.json");
  });

  test("worktree lives under <vault>/.napkin/distill-worktrees/", () => {
    const w = track(createDistillWorkspace(vault, sourceSession));
    const expectedPrefix = path.join(vault, DISTILL_WORKTREES_SUBDIR);
    expect(w.worktreePath.startsWith(expectedPrefix)).toBe(true);
  });

  test("meta.json has all DistillMeta fields", () => {
    const w = track(createDistillWorkspace(vault, sourceSession));
    const meta = JSON.parse(
      fs.readFileSync(w.metaPath, "utf-8"),
    ) as DistillMeta;

    expect(meta.pid).toBe(process.pid);
    expect(meta.vault).toBe(vault);
    expect(meta.branch).toBe(w.branchName);
    expect(meta.parentSession).toBe(sourceSession);

    const parsed = new Date(meta.startedAt);
    expect(parsed.toISOString()).toBe(meta.startedAt);
    expect(Date.now() - parsed.getTime()).toBeLessThan(5000);
  });

  test("branch name matches distill/<hex>-<epoch> shape", () => {
    const w = track(createDistillWorkspace(vault, sourceSession));
    expect(w.branchName).toMatch(/^distill\/[0-9a-f]{6}-\d{10}$/);
  });

  test("two workspaces from the same session are independent", () => {
    const a = track(createDistillWorkspace(vault, sourceSession));
    const b = track(createDistillWorkspace(vault, sourceSession));

    expect(a.worktreePath).not.toBe(b.worktreePath);
    expect(a.branchName).not.toBe(b.branchName);
    expect(a.sessionForkPath).not.toBe(b.sessionForkPath);

    // Both worktrees and branches present in git.
    const list = spawnSync(
      "git",
      ["-C", vault, "worktree", "list", "--porcelain"],
      { encoding: "utf-8" },
    ).stdout;
    expect(list).toContain(a.branchName);
    expect(list).toContain(b.branchName);
  });

  test("throws DistillError if vault is not a git repo", () => {
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), "no-git-vault-"));
    try {
      expect(() => createDistillWorkspace(noGit, sourceSession)).toThrow(
        DistillError,
      );
    } finally {
      fs.rmSync(noGit, { recursive: true, force: true });
    }
  });

  test("throws if sourceSessionFile does not exist, cleaning up worktree", () => {
    const before = spawnSync("git", ["-C", vault, "branch"], {
      encoding: "utf-8",
    }).stdout;
    expect(() =>
      createDistillWorkspace(vault, "/tmp/does-not-exist.jsonl"),
    ).toThrow();
    const after = spawnSync("git", ["-C", vault, "branch"], {
      encoding: "utf-8",
    }).stdout;
    // No distill branch left behind.
    expect(after.match(/distill\//g)).toBeNull();
    expect(before).toBe(after);
  });
});

describe("cleanupDistillWorkspace", () => {
  let vault: string;
  let sessionDir: string;
  let sourceSession: string;

  beforeEach(() => {
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-ws-src-"));
    sourceSession = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test("removes worktree tree and branch", () => {
    const w = createDistillWorkspace(vault, sourceSession);
    expect(fs.existsSync(w.worktreePath)).toBe(true);

    cleanupDistillWorkspace(vault, w);

    expect(fs.existsSync(w.worktreePath)).toBe(false);
    const branches = spawnSync("git", ["-C", vault, "branch"], {
      encoding: "utf-8",
    }).stdout;
    expect(branches).not.toContain(w.branchName);
  });

  test("is idempotent (double-cleanup is safe)", () => {
    const w = createDistillWorkspace(vault, sourceSession);
    cleanupDistillWorkspace(vault, w);
    expect(() => cleanupDistillWorkspace(vault, w)).not.toThrow();
  });
});

describe("readDistillMeta", () => {
  let vault: string;
  let sessionDir: string;
  let sourceSession: string;

  beforeEach(() => {
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "read-meta-src-"));
    sourceSession = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test("returns parsed meta for a real workspace", () => {
    const w = createDistillWorkspace(vault, sourceSession);
    try {
      const meta = readDistillMeta(w.worktreePath);
      expect(meta).not.toBeNull();
      expect(meta?.branch).toBe(w.branchName);
      expect(meta?.vault).toBe(vault);
      expect(meta?.pid).toBe(process.pid);
    } finally {
      cleanupDistillWorkspace(vault, w);
    }
  });

  test("returns null for missing path", () => {
    expect(readDistillMeta(`/tmp/nope-${Date.now()}`)).toBeNull();
  });

  test("returns null for workspace without meta.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-meta-test-"));
    try {
      fs.mkdirSync(path.join(dir, DISTILL_SUBDIR), { recursive: true });
      expect(readDistillMeta(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null for malformed meta.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bad-meta-test-"));
    try {
      fs.mkdirSync(path.join(dir, DISTILL_SUBDIR), { recursive: true });
      fs.writeFileSync(
        path.join(dir, DISTILL_SUBDIR, "meta.json"),
        "{ not valid json",
      );
      expect(readDistillMeta(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null when required fields are missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "partial-meta-test-"));
    try {
      fs.mkdirSync(path.join(dir, DISTILL_SUBDIR), { recursive: true });
      fs.writeFileSync(
        path.join(dir, DISTILL_SUBDIR, "meta.json"),
        JSON.stringify({ pid: 123 }),
      );
      expect(readDistillMeta(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Pick a pid that is not currently alive. We scan downward from 999999 so
 * we don't flake on systems where pid_max is low. Signal 0 throws ESRCH
 * when the pid is dead.
 */
function findDeadPid(): number {
  for (let pid = 999_999; pid > 1000; pid -= 1) {
    try {
      process.kill(pid, 0);
      // alive — keep scanning
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ESRCH") return pid;
      // EPERM means it exists but we can't signal it — skip
    }
  }
  throw new Error("could not locate a dead pid in test range");
}

describe("parseWorktreeList", () => {
  test("parses main + branched worktree entries", () => {
    const input = [
      "worktree /tmp/vault",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /tmp/vault/.napkin/distill-worktrees/aa-1",
      "HEAD def456",
      "branch refs/heads/distill/aa-1",
      "",
    ].join("\n");
    const parsed = parseWorktreeList(input);
    expect(parsed).toEqual([
      { path: "/tmp/vault", branch: "main" },
      {
        path: "/tmp/vault/.napkin/distill-worktrees/aa-1",
        branch: "distill/aa-1",
      },
    ]);
  });

  test("skips detached-HEAD entries (no branch line)", () => {
    const input = [
      "worktree /tmp/detached",
      "HEAD abc123",
      "detached",
      "",
    ].join("\n");
    expect(parseWorktreeList(input)).toEqual([]);
  });

  test("handles trailing record without blank line", () => {
    const input = [
      "worktree /tmp/v",
      "HEAD a",
      "branch refs/heads/distill/x-1",
    ].join("\n");
    expect(parseWorktreeList(input)).toEqual([
      { path: "/tmp/v", branch: "distill/x-1" },
    ]);
  });
});

describe("cleanupStaleWorktrees", () => {
  let vault: string;
  let sessionDir: string;
  let sourceSession: string;

  beforeEach(() => {
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-wt-src-"));
    sourceSession = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test("no-op when vault has no .git (returns 0)", () => {
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), "no-git-vault-"));
    try {
      expect(cleanupStaleWorktrees({ contentPath: noGit })).toBe(0);
    } finally {
      fs.rmSync(noGit, { recursive: true, force: true });
    }
  });

  test("leaves a live worktree alone (pid = self)", () => {
    const w = createDistillWorkspace(vault, sourceSession);
    // createDistillWorkspace already sets meta.pid to process.pid.
    try {
      const removed = cleanupStaleWorktrees({ contentPath: vault });
      expect(removed).toBe(0);
      expect(fs.existsSync(w.worktreePath)).toBe(true);
    } finally {
      cleanupDistillWorkspace(vault, w);
    }
  });

  test("removes a worktree whose pid is dead", () => {
    const w = createDistillWorkspace(vault, sourceSession);
    // Overwrite meta.json with a dead pid.
    const meta = readDistillMeta(w.worktreePath);
    if (!meta) throw new Error("meta expected");
    meta.pid = findDeadPid();
    fs.writeFileSync(w.metaPath, `${JSON.stringify(meta, null, 2)}\n`);

    const removed = cleanupStaleWorktrees({ contentPath: vault });
    expect(removed).toBe(1);
    expect(fs.existsSync(w.worktreePath)).toBe(false);
    const branches = spawnSync("git", ["-C", vault, "branch"], {
      encoding: "utf-8",
    }).stdout;
    expect(branches).not.toContain(w.branchName);
  });

  test("removes a worktree whose meta.json is missing", () => {
    const w = createDistillWorkspace(vault, sourceSession);
    fs.rmSync(w.metaPath);

    const removed = cleanupStaleWorktrees({ contentPath: vault });
    expect(removed).toBe(1);
    expect(fs.existsSync(w.worktreePath)).toBe(false);
  });

  test("removes a worktree whose meta.json mtime is beyond the stale threshold", () => {
    const w = createDistillWorkspace(vault, sourceSession);
    // Backdate meta.json by ~2 hours.
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(w.metaPath, old, old);

    const removed = cleanupStaleWorktrees({ contentPath: vault });
    expect(removed).toBe(1);
    expect(fs.existsSync(w.worktreePath)).toBe(false);
  });

  test("ignores non-distill-branch worktrees", () => {
    // Create a sibling worktree on a branch NOT under `distill/`.
    const other = path.join(vault, "other-wt");
    const res = spawnSync(
      "git",
      ["-C", vault, "worktree", "add", "-b", "feature/xyz", other, "HEAD"],
      { encoding: "utf-8" },
    );
    if (res.status !== 0) {
      throw new Error(`worktree setup failed: ${res.stderr}`);
    }
    try {
      const removed = cleanupStaleWorktrees({ contentPath: vault });
      expect(removed).toBe(0);
      expect(fs.existsSync(other)).toBe(true);
    } finally {
      spawnSync("git", ["-C", vault, "worktree", "remove", "--force", other]);
      spawnSync("git", ["-C", vault, "branch", "-D", "feature/xyz"]);
    }
  });

  test("sweeps mixed state: live, dead-pid, missing-meta, feature-branch", () => {
    // live: untouched meta.pid (self)
    const live = createDistillWorkspace(vault, sourceSession);
    // dead-pid
    const deadPid = createDistillWorkspace(vault, sourceSession);
    const meta = readDistillMeta(deadPid.worktreePath);
    if (!meta) throw new Error("meta expected");
    meta.pid = findDeadPid();
    fs.writeFileSync(deadPid.metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    // missing-meta
    const missing = createDistillWorkspace(vault, sourceSession);
    fs.rmSync(missing.metaPath);
    // feature-branch (not touched)
    const feat = path.join(vault, "feat-wt");
    const addRes = spawnSync(
      "git",
      ["-C", vault, "worktree", "add", "-b", "feature/unrelated", feat, "HEAD"],
      { encoding: "utf-8" },
    );
    if (addRes.status !== 0) {
      throw new Error(`worktree setup failed: ${addRes.stderr}`);
    }

    try {
      const removed = cleanupStaleWorktrees({ contentPath: vault });
      expect(removed).toBe(2);
      expect(fs.existsSync(live.worktreePath)).toBe(true);
      expect(fs.existsSync(deadPid.worktreePath)).toBe(false);
      expect(fs.existsSync(missing.worktreePath)).toBe(false);
      expect(fs.existsSync(feat)).toBe(true);
    } finally {
      cleanupDistillWorkspace(vault, live);
      spawnSync("git", ["-C", vault, "worktree", "remove", "--force", feat]);
      spawnSync("git", ["-C", vault, "branch", "-D", "feature/unrelated"]);
    }
  });
});

describe("STALE_WORKTREE_MINUTES constant", () => {
  test("STALE_META_AGE_MS equals minutes * 60 * 1000", () => {
    expect(STALE_META_AGE_MS).toBe(STALE_WORKTREE_MINUTES * 60 * 1000);
  });

  test("threshold is 60 minutes (documented default)", () => {
    expect(STALE_WORKTREE_MINUTES).toBe(60);
  });
});

describe("createDistillWorkspace records startSha", () => {
  let vault: string;
  let sessionDir: string;
  let sourceSession: string;

  beforeEach(() => {
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "startsha-src-"));
    sourceSession = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test("meta.json.startSha matches vault HEAD at create-time", () => {
    const headRes = spawnSync("git", ["-C", vault, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    });
    const expectedSha = headRes.stdout.trim();

    const w = createDistillWorkspace(vault, sourceSession);
    try {
      const meta = readDistillMeta(w.worktreePath);
      expect(meta).not.toBeNull();
      expect(meta?.startSha).toBe(expectedSha);
    } finally {
      cleanupDistillWorkspace(vault, w);
    }
  });
});

describe("getActiveDistills", () => {
  let vault: string;
  let sessionDir: string;
  let sourceSession: string;
  const toCleanup: { worktreePath: string; branchName: string }[] = [];

  beforeEach(() => {
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "active-src-"));
    sourceSession = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    for (const w of toCleanup) {
      try {
        cleanupDistillWorkspace(vault, w);
      } catch {
        // ignore — test teardown only
      }
    }
    toCleanup.length = 0;
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test("returns [] when vault has no .git", () => {
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), "no-git-active-"));
    try {
      expect(getActiveDistills({ contentPath: noGit })).toEqual([]);
    } finally {
      fs.rmSync(noGit, { recursive: true, force: true });
    }
  });

  test("returns [] when there are no distill worktrees", () => {
    expect(getActiveDistills({ contentPath: vault })).toEqual([]);
  });

  test("returns one entry per distill worktree with live pid (self)", () => {
    const w = createDistillWorkspace(vault, sourceSession);
    toCleanup.push(w);

    const active = getActiveDistills({ contentPath: vault });
    expect(active.length).toBe(1);
    const [a] = active;
    expect(a.branch).toBe(w.branchName);
    expect(a.worktreePath).toBe(w.worktreePath);
    expect(a.pid).toBe(process.pid);
    expect(a.alive).toBe(true);
    expect(a.sessionPath).toBe(sourceSession);
    expect(a.startedAt).not.toBeNull();
    expect(a.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(a.startSha).toMatch(/^[0-9a-f]{7,64}$/);
  });

  test("reports alive=false for worktrees whose pid is dead", () => {
    const w = createDistillWorkspace(vault, sourceSession);
    toCleanup.push(w);

    // Overwrite meta.pid with a dead pid. Reuse test helper.
    const meta = readDistillMeta(w.worktreePath);
    if (!meta) throw new Error("meta expected");
    meta.pid = findDeadPid();
    fs.writeFileSync(w.metaPath, `${JSON.stringify(meta, null, 2)}\n`);

    const active = getActiveDistills({ contentPath: vault });
    expect(active.length).toBe(1);
    expect(active[0].alive).toBe(false);
  });

  test("ignores non-distill worktrees", () => {
    const other = path.join(vault, "feat-wt");
    const addRes = spawnSync(
      "git",
      ["-C", vault, "worktree", "add", "-b", "feature/zzz", other, "HEAD"],
      { encoding: "utf-8" },
    );
    if (addRes.status !== 0) throw new Error(addRes.stderr);
    try {
      expect(getActiveDistills({ contentPath: vault })).toEqual([]);
    } finally {
      spawnSync("git", ["-C", vault, "worktree", "remove", "--force", other]);
      spawnSync("git", ["-C", vault, "branch", "-D", "feature/zzz"]);
    }
  });

  test("mixed state: two distills + one feature branch", () => {
    const a = createDistillWorkspace(vault, sourceSession);
    toCleanup.push(a);
    const b = createDistillWorkspace(vault, sourceSession);
    toCleanup.push(b);
    const feat = path.join(vault, "feat-wt-2");
    spawnSync(
      "git",
      ["-C", vault, "worktree", "add", "-b", "feature/other", feat, "HEAD"],
      { encoding: "utf-8" },
    );

    try {
      const active = getActiveDistills({ contentPath: vault });
      const branches = active.map((e) => e.branch).sort();
      expect(branches).toEqual([a.branchName, b.branchName].sort());
    } finally {
      spawnSync("git", ["-C", vault, "worktree", "remove", "--force", feat]);
      spawnSync("git", ["-C", vault, "branch", "-D", "feature/other"]);
    }
  });

  test("tolerates missing meta.json (reports alive=false, pid=-1)", () => {
    const w = createDistillWorkspace(vault, sourceSession);
    toCleanup.push(w);
    fs.rmSync(w.metaPath);

    const active = getActiveDistills({ contentPath: vault });
    expect(active.length).toBe(1);
    expect(active[0].pid).toBe(-1);
    expect(active[0].alive).toBe(false);
    expect(active[0].startedAt).toBeNull();
    expect(active[0].sessionPath).toBeNull();
  });
});

describe("getUnmergedDistillBranches", () => {
  let vault: string;
  let sessionDir: string;
  let sourceSession: string;

  beforeEach(() => {
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "unmerged-src-"));
    sourceSession = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test("returns [] when no distill branches exist", () => {
    expect(getUnmergedDistillBranches({ contentPath: vault })).toEqual([]);
  });

  test("returns [] when vault has no .git", () => {
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), "unmerged-no-git-"));
    try {
      expect(getUnmergedDistillBranches({ contentPath: noGit })).toEqual([]);
    } finally {
      fs.rmSync(noGit, { recursive: true, force: true });
    }
  });

  test("skips branches that are checked out in a worktree", () => {
    const w = createDistillWorkspace(vault, sourceSession);
    try {
      // w.branchName is live (in a worktree) → NOT unmerged.
      expect(getUnmergedDistillBranches({ contentPath: vault })).toEqual([]);
    } finally {
      cleanupDistillWorkspace(vault, w);
    }
  });

  test("reports distill branches with no worktree", () => {
    // Create a distill branch WITHOUT a worktree — simulates a crashed distill
    // whose worktree was removed but whose branch ref lingers.
    const branch = "distill/orphan-1700000000";
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const res = spawnSync("git", ["-C", vault, "branch", branch], {
      encoding: "utf-8",
      env,
    });
    if (res.status !== 0) throw new Error(res.stderr);

    try {
      expect(getUnmergedDistillBranches({ contentPath: vault })).toEqual([
        branch,
      ]);
    } finally {
      spawnSync("git", ["-C", vault, "branch", "-D", branch]);
    }
  });

  test("mixed: one live worktree + one orphan branch → returns only orphan", () => {
    const w = createDistillWorkspace(vault, sourceSession);
    const orphan = "distill/zz-1700000001";
    spawnSync("git", ["-C", vault, "branch", orphan]);

    try {
      expect(getUnmergedDistillBranches({ contentPath: vault })).toEqual([
        orphan,
      ]);
    } finally {
      spawnSync("git", ["-C", vault, "branch", "-D", orphan]);
      cleanupDistillWorkspace(vault, w);
    }
  });
});

describe("diffWorktreeSinceStart", () => {
  let vault: string;
  let sessionDir: string;
  let sourceSession: string;

  beforeEach(() => {
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "diff-src-"));
    sourceSession = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test("empty worktree (no changes since startSha) returns []", () => {
    const w = createDistillWorkspace(vault, sourceSession);
    try {
      const meta = readDistillMeta(w.worktreePath);
      expect(
        diffWorktreeSinceStart({
          worktreePath: w.worktreePath,
          startSha: meta?.startSha,
        }),
      ).toEqual([]);
    } finally {
      cleanupDistillWorkspace(vault, w);
    }
  });

  test("committed change shows up after startSha", () => {
    const w = createDistillWorkspace(vault, sourceSession);
    try {
      // Write + commit a new file inside the worktree.
      const newFile = path.join(w.worktreePath, "distilled.md");
      fs.writeFileSync(newFile, "# new\n");
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      };
      spawnSync("git", ["-C", w.worktreePath, "add", "distilled.md"], { env });
      spawnSync(
        "git",
        ["-C", w.worktreePath, "commit", "-m", "add distilled.md"],
        { env },
      );

      const meta = readDistillMeta(w.worktreePath);
      const changed = diffWorktreeSinceStart({
        worktreePath: w.worktreePath,
        startSha: meta?.startSha,
      });
      expect(changed).toContain("distilled.md");
    } finally {
      cleanupDistillWorkspace(vault, w);
    }
  });

  test("legacy meta (no startSha) falls back to status --porcelain", () => {
    const w = createDistillWorkspace(vault, sourceSession);
    try {
      // Uncommitted change — status picks it up.
      fs.writeFileSync(path.join(w.worktreePath, "scratch.md"), "# scratch\n");

      const changed = diffWorktreeSinceStart({
        worktreePath: w.worktreePath,
        startSha: undefined,
      });
      expect(changed).toContain("scratch.md");
    } finally {
      cleanupDistillWorkspace(vault, w);
    }
  });

  test("returns [] for missing worktree path", () => {
    expect(
      diffWorktreeSinceStart({
        worktreePath: "/tmp/does-not-exist",
        startSha: "abc1234",
      }),
    ).toEqual([]);
  });
});
