import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@mariozechner/pi-coding-agent";

import {
  cleanupDistillWorkspace,
  createDistillWorkspace,
  DISTILL_SUBDIR,
  type DistillMeta,
  generateDistillBranchName,
  readDistillMeta,
} from "./distill-workspace";

/**
 * Minimal real session file to feed SessionManager.forkFrom. The fork API
 * rejects empty session files; SessionManager only flushes to disk once an
 * assistant message is present (see `_persist` in pi's session-manager.js).
 * We seed with a user\/assistant round-trip so the file is on disk and valid.
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

describe("createDistillWorkspace", () => {
  let sessionDir: string;
  let sourceSession: string;
  const workspaces: string[] = [];

  beforeEach(() => {
    sessionDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "distill-workspace-test-src-"),
    );
    sourceSession = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    for (const wp of workspaces) {
      fs.rmSync(wp, { recursive: true, force: true });
    }
    workspaces.length = 0;
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  function track<T extends { worktreePath: string }>(w: T): T {
    workspaces.push(w.worktreePath);
    return w;
  }

  test("creates <wt>/.napkin/distill/ with session.jsonl and meta.json", () => {
    const w = track(createDistillWorkspace("/fake/vault/path", sourceSession));

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

  test("meta.json has all DistillMeta fields", () => {
    const w = track(createDistillWorkspace("/fake/vault/path", sourceSession));
    const meta = JSON.parse(
      fs.readFileSync(w.metaPath, "utf-8"),
    ) as DistillMeta;

    expect(meta.pid).toBe(process.pid);
    expect(meta.vault).toBe("/fake/vault/path");
    expect(meta.branch).toBe(w.branchName);
    expect(meta.parentSession).toBe(sourceSession);

    // ISO timestamp check \u2014 parsable and recent.
    const parsed = new Date(meta.startedAt);
    expect(parsed.toISOString()).toBe(meta.startedAt);
    expect(Date.now() - parsed.getTime()).toBeLessThan(5000);
  });

  test("branch name matches distill/<hex>-<epoch> shape", () => {
    const w = track(createDistillWorkspace("/fake/vault/path", sourceSession));
    expect(w.branchName).toMatch(/^distill\/[0-9a-f]{6}-\d{10}$/);
  });

  test("two workspaces from the same session are independent", () => {
    const a = track(createDistillWorkspace("/fake/vault/path", sourceSession));
    const b = track(createDistillWorkspace("/fake/vault/path", sourceSession));

    expect(a.worktreePath).not.toBe(b.worktreePath);
    expect(a.branchName).not.toBe(b.branchName);
    expect(a.sessionForkPath).not.toBe(b.sessionForkPath);
  });

  test("throws if sourceSessionFile does not exist", () => {
    expect(() =>
      createDistillWorkspace("/fake", "/tmp/does-not-exist.jsonl"),
    ).toThrow();
  });

  test("cleans up tmp dir when fork fails", () => {
    const beforeTmp = fs
      .readdirSync(os.tmpdir())
      .filter((n) => n.startsWith("napkin-distill-")).length;

    try {
      createDistillWorkspace("/fake", "/tmp/does-not-exist.jsonl");
    } catch {
      // expected
    }

    const afterTmp = fs
      .readdirSync(os.tmpdir())
      .filter((n) => n.startsWith("napkin-distill-")).length;
    expect(afterTmp).toBe(beforeTmp);
  });
});

describe("cleanupDistillWorkspace", () => {
  test("removes workspace tree", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-test-"));
    fs.mkdirSync(path.join(dir, "nested", "deep"), { recursive: true });
    fs.writeFileSync(path.join(dir, "file.txt"), "data");

    cleanupDistillWorkspace(dir);

    expect(fs.existsSync(dir)).toBe(false);
  });

  test("is idempotent (no throw on missing path)", () => {
    const dir = path.join(os.tmpdir(), `cleanup-missing-${Date.now()}`);
    expect(fs.existsSync(dir)).toBe(false);
    expect(() => cleanupDistillWorkspace(dir)).not.toThrow();
    // Second call still fine.
    expect(() => cleanupDistillWorkspace(dir)).not.toThrow();
  });
});

describe("readDistillMeta", () => {
  let sessionDir: string;
  let sourceSession: string;

  beforeEach(() => {
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "read-meta-test-src-"));
    sourceSession = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  test("returns parsed meta for a real workspace", () => {
    const w = createDistillWorkspace("/fake/vault", sourceSession);
    try {
      const meta = readDistillMeta(w.worktreePath);
      expect(meta).not.toBeNull();
      expect(meta?.branch).toBe(w.branchName);
      expect(meta?.vault).toBe("/fake/vault");
      expect(meta?.pid).toBe(process.pid);
    } finally {
      cleanupDistillWorkspace(w.worktreePath);
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
