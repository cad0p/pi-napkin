/**
 * Origin-first distill integration tests.
 *
 * These tests use a throwaway vault plus a bare origin. They pin the 2026-11
 * contract change: when origin exists, the distill agent integrates entirely
 * inside its worktree and pushes HEAD:<default>; the shared vault checkout is
 * not a merge scratchpad and must remain untouched until the vault's own sync
 * brings it forward.
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

const FIXTURES_DIR = path.join(__dirname, "test-fixtures", "agent-stubs");

function fixturePath(name: string): string {
  const p = path.join(FIXTURES_DIR, name);
  if (!fs.existsSync(p)) throw new Error(`fixture not found: ${p}`);
  return p;
}

function git(args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (rc ${r.status}): ${r.stderr || r.stdout}`,
    );
  }
  return r.stdout.trim();
}

function setupOriginForVault(root: string, vault: string): string {
  const originPath = path.join(root, "origin.git");
  git(["init", "--bare", "-b", "main", originPath]);
  git(["-C", vault, "remote", "add", "origin", originPath]);
  git(["-C", vault, "push", "-u", "origin", "main"]);
  return originPath;
}

function cloneSide(root: string, originPath: string, name: string): string {
  const side = path.join(root, name);
  git(["clone", "-q", originPath, side]);
  git(["-C", side, "config", "user.email", "side@example.com"]);
  git(["-C", side, "config", "user.name", "side"]);
  return side;
}

function pushSideCommit(side: string, message: string): string {
  git(["-C", side, "add", "-A"]);
  git(["-C", side, "commit", "-m", message]);
  git(["-C", side, "push", "origin", "main"]);
  return git(["-C", side, "rev-parse", "main"]);
}

function originShow(originPath: string, relPath: string): string {
  return git(["--git-dir", originPath, "show", `main:${relPath}`]);
}

function originHasPath(originPath: string, relPath: string): boolean {
  const r = spawnSync(
    "git",
    ["--git-dir", originPath, "cat-file", "-e", `main:${relPath}`],
    { encoding: "utf-8" },
  );
  return r.status === 0;
}

describe("distill origin integration (bare origin, worktree-only)", () => {
  let pathHandle: { restore: () => void };

  beforeEach(() => {
    pathHandle = withNapkinOnPath();
  });

  afterEach(() => {
    pathHandle.restore();
  });

  test("origin moved on a different file: pushed, shared checkout untouched", () => {
    const s = makeWrapperScaffold("napkin-origin-diff-file-");
    try {
      const originPath = setupOriginForVault(s.root, s.vault);
      const side = cloneSide(s.root, originPath, "side-clone");
      fs.writeFileSync(path.join(side, "side.md"), "# side\n");
      pushSideCommit(side, "side: concurrent different file");

      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("pushed-success.sh"),
      });

      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-content");
      expect(originShow(originPath, "side.md")).toBe("# side");
      expect(originShow(originPath, "pushed.md")).toBe("# pushed");
      expect(git(["-C", s.vault, "rev-parse", "main"])).toBe(r.preSha);
      expect(fs.existsSync(path.join(s.vault, "side.md"))).toBe(false);
      expect(fs.existsSync(path.join(s.vault, "pushed.md"))).toBe(false);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("origin moved on the same note: merged in the worktree, pushed, checkout untouched", () => {
    const s = makeWrapperScaffold("napkin-origin-same-note-");
    try {
      const originPath = setupOriginForVault(s.root, s.vault);
      const side = cloneSide(s.root, originPath, "side-clone");
      fs.writeFileSync(
        path.join(side, "seed.md"),
        "# seed\n\norigin concurrent line\n",
      );
      pushSideCommit(side, "side: concurrent same note");

      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("origin-same-note-merge-push.sh"),
      });

      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-content");
      const merged = originShow(originPath, "seed.md");
      expect(merged).toContain("origin concurrent line");
      expect(merged).toContain("distill session line");
      expect(merged).not.toMatch(/^<{7} /m);
      expect(merged).not.toMatch(/^={7}$/m);
      expect(merged).not.toMatch(/^>{7} /m);
      expect(git(["-C", s.vault, "rev-parse", "main"])).toBe(r.preSha);
      expect(fs.readFileSync(path.join(s.vault, "seed.md"), "utf-8")).toBe(
        "# seed\n",
      );
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("push race: non-fast-forward is integrated and retried in the worktree", () => {
    const s = makeWrapperScaffold("napkin-origin-push-race-");
    try {
      const originPath = setupOriginForVault(s.root, s.vault);
      const attemptFile = path.join(s.root, "push-attempts.txt");
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("push-race-retry-success.sh"),
        extraEnv: { NAPKIN_STUB_ATTEMPT_FILE: attemptFile },
      });

      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-content");
      expect(fs.readFileSync(attemptFile, "utf-8")).toContain(
        "push-attempts=2",
      );
      expect(originShow(originPath, "race.md")).toBe("# concurrent race");
      expect(originShow(originPath, "race-retried.md")).toBe("# race retried");
      expect(git(["-C", s.vault, "rev-parse", "main"])).toBe(r.preSha);
      expect(fs.existsSync(path.join(s.vault, "race.md"))).toBe(false);
      expect(fs.existsSync(path.join(s.vault, "race-retried.md"))).toBe(false);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("no origin: legacy local squash into the shared checkout is preserved", () => {
    const s = makeWrapperScaffold("napkin-origin-none-");
    try {
      expect(git(["-C", s.vault, "remote"])).toBe("");
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("local-no-origin-squash.sh"),
      });

      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-local");
      expect(
        fs.readFileSync(path.join(s.vault, "local-no-origin.md"), "utf-8"),
      ).toBe("# local no origin\n");
      expect(git(["-C", s.vault, "rev-parse", "main"])).not.toBe(r.preSha);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("origin-integrated but unpushed commit: failed loudly with dangling sha", () => {
    const s = makeWrapperScaffold("napkin-origin-unpushed-");
    try {
      const originPath = setupOriginForVault(s.root, s.vault);
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("origin-integrate-no-push.sh"),
      });

      expect(r.exitCode).toBe(1);
      expect(r.outcome).toBe("failed:push-not-landed");
      expect(r.outcomePath).not.toBeNull();
      const sidecar = fs.readFileSync(r.outcomePath as string, "utf-8");
      expect(sidecar).toMatch(/Dangling commit: [0-9a-f]{40}\./);

      const ledgerPath = path.join(s.errorDir, "failures.log");
      expect(fs.existsSync(ledgerPath)).toBe(true);
      const ledger = fs.readFileSync(ledgerPath, "utf-8");
      expect(ledger).toContain("failed:push-not-landed");
      expect(ledger).toContain(`branch=${r.branch}`);
      expect(ledger).toMatch(/dangling=[0-9a-f]{40}/);

      expect(originHasPath(originPath, "unpushed.md")).toBe(false);
      expect(git(["-C", s.vault, "rev-parse", "main"])).toBe(r.preSha);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("pre-copied session writes ride the pushed distill commit; outside-vault writes are ignored", () => {
    const s = makeWrapperScaffold("napkin-origin-session-write-");
    try {
      const originPath = setupOriginForVault(s.root, s.vault);
      const note = path.join(s.vault, "daily", "session-write.md");
      fs.mkdirSync(path.dirname(note), { recursive: true });
      fs.writeFileSync(note, "# direct session write\n");
      const outside = path.join(s.root, "outside-vault.md");
      fs.writeFileSync(outside, "# outside\n");

      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("pushed-success.sh"),
        sessionTouchedFiles: [note, outside],
      });

      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-content");
      expect(originShow(originPath, "daily/session-write.md")).toBe(
        "# direct session write",
      );
      expect(originShow(originPath, "pushed.md")).toBe("# pushed");
      expect(originHasPath(originPath, "outside-vault.md")).toBe(false);
      // Copy-only handoff: the shared checkout's untracked copy is not removed
      // or rewritten by distill. The vault sync can later reconcile it.
      expect(fs.readFileSync(note, "utf-8")).toBe("# direct session write\n");
      expect(git(["-C", s.vault, "rev-parse", "main"])).toBe(r.preSha);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("two commits land on origin: session autocommit + distill, disjoint file sets", () => {
    const s = makeWrapperScaffold("napkin-origin-two-commits-");
    try {
      const originPath = setupOriginForVault(s.root, s.vault);
      const note = path.join(s.vault, "daily", "session-write.md");
      fs.mkdirSync(path.dirname(note), { recursive: true });
      fs.writeFileSync(note, "# session bytes\n");

      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("origin-two-commits.sh"),
        sessionTouchedFiles: [note],
      });

      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-content");

      const subjects = git([
        "--git-dir",
        originPath,
        "log",
        "-2",
        "--format=%s",
        "main",
      ]).split("\n");
      expect(subjects[0]).toBe("distill: two commits");
      expect(subjects[1]).toMatch(/^autocommit: 1 files? written by session /);

      // Commit (a) owns only the session's paths; commit (b) only the
      // distill's own note.
      expect(
        git([
          "--git-dir",
          originPath,
          "show",
          "--name-only",
          "--format=",
          "main^",
        ]),
      ).toBe("daily/session-write.md");
      expect(
        git([
          "--git-dir",
          originPath,
          "show",
          "--name-only",
          "--format=",
          "main",
        ]),
      ).toBe("distill-note.md");
      expect(originShow(originPath, "daily/session-write.md")).toBe(
        "# session bytes",
      );
      expect(originShow(originPath, "distill-note.md")).toBe(
        "# distill two commits",
      );
      // The push carried both commits; the shared checkout is untouched.
      expect(git(["-C", s.vault, "rev-parse", "main"])).toBe(r.preSha);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("session file also edited by distill: (a) keeps original bytes, (b) carries the edit", () => {
    const s = makeWrapperScaffold("napkin-origin-two-commits-edit-");
    try {
      const originPath = setupOriginForVault(s.root, s.vault);
      const note = path.join(s.vault, "daily", "session-write.md");
      fs.mkdirSync(path.dirname(note), { recursive: true });
      fs.writeFileSync(note, "# session bytes\n");

      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("origin-two-commits.sh"),
        sessionTouchedFiles: [note],
        extraEnv: { NAPKIN_STUB_EDIT_SESSION_FILE: "1" },
      });

      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-content");
      // Same path, two commits: (a) the original bytes, (b) the edit on top.
      expect(originShow(originPath, "daily/session-write.md")).toBe(
        "# session bytes\ndistill edit",
      );
      expect(
        git([
          "--git-dir",
          originPath,
          "show",
          "--name-only",
          "--format=",
          "main^",
        ]),
      ).toBe("daily/session-write.md");
      expect(
        git([
          "--git-dir",
          originPath,
          "show",
          "--name-only",
          "--format=",
          "main",
        ]),
      ).toBe("daily/session-write.md\ndistill-note.md");
      expect(
        git(["--git-dir", originPath, "show", "main^:daily/session-write.md"]),
      ).toBe("# session bytes");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });
});
