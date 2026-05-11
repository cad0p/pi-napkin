import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@mariozechner/pi-coding-agent";

import {
  cleanupDistillWorkspace,
  createDistillWorkspace,
  createDistillWorktree,
  DISTILL_SUBDIR,
  DISTILL_WORKTREES_SUBDIR,
  DistillError,
  type DistillMeta,
  generateDistillBranchName,
  readDistillMeta,
  removeDistillWorktree,
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
