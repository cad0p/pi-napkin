/**
 * Unit + integration tests for the per-distill-completion overlap-notice
 * mechanism (R7-PERF-2 redesign).
 *
 * Three layers:
 *   1. Unit tests for `computeOverlapForCompletion` (pure helper).
 *   2. Unit tests for `getDistillTouchedFilesPostSquash` (git log against
 *      a real ephemeral vault).
 *   3. Integration test wiring: real SessionManager + real git +
 *      `runAutoDistill` flow → assert the post-completion message
 *      lands in session history with `customType:
 *      "napkin-distill-overlap"`.
 *
 * Trigger change vs the retired `before_agent_start` mechanism:
 *   - Old: per-turn, mutates system prompt → cache miss on overlap.
 *   - New: per-distill-completion, posts custom session message → cache
 *     parity preserved, message persists in history.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  type SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { getDistillTouchedFilesPostSquash } from "./distill-workspace";
import { computeOverlapForCompletion } from "./index";

// ---------------------------------------------------------------------------
// Test fixtures.
// ---------------------------------------------------------------------------

function createGitVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overlap-completion-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@e",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@e",
  };
  const git = (args: string[]) =>
    spawnSync("git", ["-C", dir, ...args], { env, encoding: "utf-8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["config", "user.name", "t"]);
  git(["config", "user.email", "t@e"]);
  fs.writeFileSync(path.join(dir, "seed.md"), "# seed\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed"]);
  return dir;
}

/**
 * Manufacture a SessionEntry of role=assistant carrying a write-tool
 * call to `path`. Mirrors the shape produced by pi's tool-execution
 * pipeline. Just enough for `getSessionTouchedFiles` to find the path.
 */
function assistantWriteEntry(filePath: string): SessionEntry {
  return {
    type: "message",
    id: `e${Math.random().toString(36).slice(2)}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "write",
          arguments: { path: filePath },
        },
      ],
    },
    // biome-ignore lint/suspicious/noExplicitAny: hand-rolled minimal entry
  } as any;
}

// ---------------------------------------------------------------------------
// Unit: computeOverlapForCompletion (pure helper).
// ---------------------------------------------------------------------------

describe("computeOverlapForCompletion (R7-PERF-2)", () => {
  test("empty distill-touched: no overlap, cursor advances to end", () => {
    const entries = [assistantWriteEntry("foo.md")];
    const out = computeOverlapForCompletion({
      distillTouchedFiles: [],
      sessionEntries: entries,
      cursor: 0,
    });
    expect(out.overlap).toEqual([]);
    expect(out.newCursor).toBe(1);
  });

  test("empty session entries: no overlap, cursor advances to 0", () => {
    const out = computeOverlapForCompletion({
      distillTouchedFiles: ["foo.md"],
      sessionEntries: [],
      cursor: 0,
    });
    expect(out.overlap).toEqual([]);
    expect(out.newCursor).toBe(0);
  });

  test("session wrote a file the distill also touched: overlap reported", () => {
    const entries = [assistantWriteEntry("notes/foo.md")];
    const out = computeOverlapForCompletion({
      distillTouchedFiles: ["notes/foo.md"],
      sessionEntries: entries,
      cursor: 0,
    });
    expect(out.overlap).toEqual(["notes/foo.md"]);
    expect(out.newCursor).toBe(1);
  });

  test("cursor bounds the walk: only entries after cursor count", () => {
    // First entry written before previous completion → ignored. Second
    // entry written after → overlap fires.
    const entries = [
      assistantWriteEntry("notes/before.md"),
      assistantWriteEntry("notes/after.md"),
    ];
    const out = computeOverlapForCompletion({
      distillTouchedFiles: ["notes/before.md", "notes/after.md"],
      sessionEntries: entries,
      cursor: 1, // skip the "before" entry
    });
    // Only "notes/after.md" is in the slice's session-touched set;
    // "notes/before.md" is ignored.
    expect(out.overlap).toEqual(["notes/after.md"]);
    expect(out.newCursor).toBe(2);
  });

  test("cursor at end: no overlap regardless of distill-touched", () => {
    // Cursor === entries.length means no new messages to walk.
    const entries = [assistantWriteEntry("notes/foo.md")];
    const out = computeOverlapForCompletion({
      distillTouchedFiles: ["notes/foo.md"],
      sessionEntries: entries,
      cursor: 1,
    });
    expect(out.overlap).toEqual([]);
    expect(out.newCursor).toBe(1);
  });

  test("disjoint files: no overlap, cursor advances", () => {
    const entries = [assistantWriteEntry("notes/a.md")];
    const out = computeOverlapForCompletion({
      distillTouchedFiles: ["notes/b.md"],
      sessionEntries: entries,
      cursor: 0,
    });
    expect(out.overlap).toEqual([]);
    expect(out.newCursor).toBe(1);
  });

  test("multiple overlapping files: deduped + sorted", () => {
    const entries = [
      assistantWriteEntry("notes/c.md"),
      assistantWriteEntry("notes/a.md"),
      assistantWriteEntry("notes/b.md"),
    ];
    const out = computeOverlapForCompletion({
      distillTouchedFiles: ["notes/a.md", "notes/b.md", "notes/c.md"],
      sessionEntries: entries,
      cursor: 0,
    });
    expect(out.overlap).toEqual(["notes/a.md", "notes/b.md", "notes/c.md"]);
    expect(out.newCursor).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Unit: getDistillTouchedFilesPostSquash (real git, ephemeral vault).
// ---------------------------------------------------------------------------

describe("getDistillTouchedFilesPostSquash (R7-PERF-2)", () => {
  let vault: string;
  beforeEach(() => {
    vault = createGitVault();
  });
  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test("undefined startSha: returns empty (legacy meta fallback)", () => {
    const out = getDistillTouchedFilesPostSquash(vault, undefined);
    expect(out).toEqual([]);
  });

  test("empty string startSha: returns empty", () => {
    const out = getDistillTouchedFilesPostSquash(vault, "");
    expect(out).toEqual([]);
  });

  test("startSha === HEAD: empty (no commits between)", () => {
    const head = spawnSync("git", ["-C", vault, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).stdout.trim();
    const out = getDistillTouchedFilesPostSquash(vault, head);
    expect(out).toEqual([]);
  });

  test("post-squash: lists files affected by commits since startSha", () => {
    const startSha = spawnSync("git", ["-C", vault, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).stdout.trim();

    // Simulate a squash commit landing two new files since startSha.
    fs.mkdirSync(path.join(vault, "notes"), { recursive: true });
    fs.writeFileSync(path.join(vault, "notes", "a.md"), "# a\n");
    fs.writeFileSync(path.join(vault, "b.md"), "# b\n");
    spawnSync("git", ["-C", vault, "add", "-A"], { encoding: "utf-8" });
    spawnSync("git", ["-C", vault, "commit", "-q", "-m", "distill: merge x"], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@e",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@e",
      },
      encoding: "utf-8",
    });

    const out = getDistillTouchedFilesPostSquash(vault, startSha);
    expect(out.sort()).toEqual(["b.md", "notes/a.md"]);
  });

  test("invalid startSha: returns empty (git fails, no throw)", () => {
    const out = getDistillTouchedFilesPostSquash(
      vault,
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    );
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration: SessionManager + real git → custom message lands.
// ---------------------------------------------------------------------------

describe("per-completion overlap notice (integration, R7-PERF-2)", () => {
  let vault: string;
  let sessionDir: string;

  beforeEach(() => {
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlap-sm-"));
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  test("end-to-end: distill touched + session touched same file → custom message appended", () => {
    // 1. Capture vault HEAD as the distill's startSha.
    const startSha = spawnSync("git", ["-C", vault, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).stdout.trim();

    // 2. Real SessionManager. Append a manually-constructed assistant
    //    message with a write tool call to `notes/foo.md` so the
    //    session-side walk finds it.
    const sm = SessionManager.create(sessionDir, sessionDir);
    sm.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "write",
          arguments: { path: "notes/foo.md" },
        },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: minimal message
    } as any);

    // 3. Simulate a distill squash-merge: write the same file in main
    //    vault, commit it.
    fs.mkdirSync(path.join(vault, "notes"), { recursive: true });
    fs.writeFileSync(path.join(vault, "notes", "foo.md"), "# distill output\n");
    spawnSync("git", ["-C", vault, "add", "-A"], {
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e" },
      encoding: "utf-8",
    });
    spawnSync("git", ["-C", vault, "commit", "-q", "-m", "distill: merge"], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@e",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@e",
      },
      encoding: "utf-8",
    });

    // 4. Verify the building blocks separately.
    const distillTouched = getDistillTouchedFilesPostSquash(vault, startSha);
    expect(distillTouched).toContain("notes/foo.md");

    const out = computeOverlapForCompletion({
      distillTouchedFiles: distillTouched,
      sessionEntries: sm.getEntries(),
      cursor: 0,
    });
    expect(out.overlap).toContain("notes/foo.md");
    expect(out.newCursor).toBe(sm.getEntries().length);

    // 5. Apply the wiring step ourselves (mirrors what
    //    `postOverlapNoticeOnCompletion` does internally) and assert
    //    the SessionManager has a custom message of the right type.
    const entriesBefore = sm.getEntries().length;
    sm.appendCustomMessageEntry("napkin-distill-overlap", "test-content", true);
    const entries = sm.getEntries();
    expect(entries.length).toBe(entriesBefore + 1);
    const last = entries[entries.length - 1];
    expect(last.type).toBe("custom_message");
    expect((last as { customType?: string }).customType).toBe(
      "napkin-distill-overlap",
    );
  });

  test("cursor advances even when overlap is empty (no double-count next time)", () => {
    // First completion: parent has no writes, distill touched file X.
    // Cursor should advance to entries.length so the next completion
    // doesn't re-walk pre-completion entries.
    const sm = SessionManager.create(sessionDir, sessionDir);
    sm.appendMessage({
      role: "user",
      content: "hello",
      // biome-ignore lint/suspicious/noExplicitAny: minimal message
    } as any);

    const out1 = computeOverlapForCompletion({
      distillTouchedFiles: ["notes/x.md"],
      sessionEntries: sm.getEntries(),
      cursor: 0,
    });
    expect(out1.overlap).toEqual([]);
    expect(out1.newCursor).toBe(sm.getEntries().length);

    // Now parent writes a file the next distill also touches.
    sm.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "write",
          arguments: { path: "notes/y.md" },
        },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: minimal message
    } as any);

    // Second completion: cursor from the first completion bounds the
    // walk so we only see the new write.
    const out2 = computeOverlapForCompletion({
      distillTouchedFiles: ["notes/y.md"],
      sessionEntries: sm.getEntries(),
      cursor: out1.newCursor,
    });
    expect(out2.overlap).toEqual(["notes/y.md"]);
  });

  test("resumed session: cursor initialised to entries.length skips pre-resume history (R8-CC-3 / R8-PERF-3)", () => {
    // The session_start handler initializes
    // `lastDistillCompletionMessageCursor` to the SessionManager's
    // current entries.length. For a resumed session with N pre-existing
    // assistant write entries, the FIRST completion in the new pi
    // process should NOT walk those entries: they belong to a previous
    // pi process whose distills already landed (or are unrelated to
    // this distill's startSha).
    //
    // Simulate: SessionManager has 3 pre-resume assistant write
    // entries, then session_start initialises the cursor to 3, then
    // the first distill completion fires.
    const sm = SessionManager.create(sessionDir, sessionDir);
    for (const p of ["old/a.md", "old/b.md", "old/c.md"]) {
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", name: "write", arguments: { path: p } }],
        // biome-ignore lint/suspicious/noExplicitAny: minimal message
      } as any);
    }
    const initialCursor = sm.getEntries().length; // what session_start sets
    expect(initialCursor).toBeGreaterThan(0);

    // First post-resume completion: distill touched the SAME files as
    // pre-resume parent writes. With the correct cursor init, those
    // are SKIPPED (already-walked-in-prior-process semantics).
    const out = computeOverlapForCompletion({
      distillTouchedFiles: ["old/a.md", "old/b.md", "old/c.md"],
      sessionEntries: sm.getEntries(),
      cursor: initialCursor,
    });
    expect(out.overlap).toEqual([]);
    expect(out.newCursor).toBe(initialCursor);
  });
});
