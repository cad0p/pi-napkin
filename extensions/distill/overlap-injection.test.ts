/**
 * Unit tests for the overlap-notice pure helpers.
 *
 * Both the per-distill-completion `appendCustomMessageEntry` path
 * (R7-PERF-2 redesign, current) and the previous per-turn
 * `before_agent_start` mechanism (R7-PERF-2 — retired) drove these
 * helpers; they're trigger-agnostic. The session-side file extraction
 * is covered separately in `session-touched-files.test.ts`. Here we
 * test the intersection + message formatting.
 *
 * The new per-completion handler wiring (vault-resolve, git-log
 * post-squash, session-walk-since-cursor, custom-message append) is
 * covered in `overlap-completion.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { formatOverlapNotice, intersectFiles } from "./index";

describe("intersectFiles", () => {
  test("no session-touched: empty overlap", () => {
    expect(intersectFiles(new Set<string>(), new Set(["foo.md"]))).toEqual([]);
  });

  test("no distill-touched: empty overlap", () => {
    expect(intersectFiles(new Set(["foo.md"]), new Set<string>())).toEqual([]);
  });

  test("both empty: empty overlap", () => {
    expect(intersectFiles(new Set<string>(), new Set<string>())).toEqual([]);
  });

  test("exact-equal paths overlap", () => {
    expect(
      intersectFiles(new Set(["notes/a.md"]), new Set(["notes/a.md"])),
    ).toEqual(["notes/a.md"]);
  });

  test("disjoint paths: no overlap", () => {
    expect(intersectFiles(new Set(["a.md"]), new Set(["b.md"]))).toEqual([]);
  });

  test("session absolute vs distill relative: matched via basename", () => {
    // Simulates: session wrote `/home/user/vault/notes/foo.md`, distill
    // touched `notes/foo.md` (relative to worktree root). The overlap
    // should surface under the distill-side path.
    expect(
      intersectFiles(
        new Set(["/home/user/vault/notes/foo.md"]),
        new Set(["notes/foo.md"]),
      ),
    ).toEqual(["notes/foo.md"]);
  });

  test("basename collision across unrelated dirs: still reported (best-effort)", () => {
    // Known false-positive shape — two `README.md`s in different dirs.
    // We accept this trade-off; overlap notice is heuristic by design.
    expect(
      intersectFiles(
        new Set(["/abs/pkg-a/README.md"]),
        new Set(["pkg-b/README.md"]),
      ),
    ).toEqual(["pkg-b/README.md"]);
  });

  test("multiple overlaps: deduped + sorted output", () => {
    expect(
      intersectFiles(
        new Set(["a.md", "b.md", "c.md"]),
        new Set(["b.md", "c.md", "d.md"]),
      ),
    ).toEqual(["b.md", "c.md"]);
  });

  test("suffix-match in either direction", () => {
    // session path is a suffix of distill path
    expect(
      intersectFiles(new Set(["foo.md"]), new Set(["a/b/c/foo.md"])),
    ).toEqual(["a/b/c/foo.md"]);
    // distill path is a suffix of session path
    expect(
      intersectFiles(new Set(["/abs/a/b/c/foo.md"]), new Set(["c/foo.md"])),
    ).toEqual(["c/foo.md"]);
  });
});

describe("formatOverlapNotice", () => {
  test("empty overlap: empty string (0-token 'quiet' case)", () => {
    expect(formatOverlapNotice([])).toBe("");
  });

  test("single file: notice contains the file name", () => {
    const notice = formatOverlapNotice(["notes/foo.md"]);
    expect(notice).toContain("notes/foo.md");
    expect(notice).toContain("Background napkin distill");
    // Leading double newline so it doesn't smash into the previous
    // system-prompt content.
    expect(notice.startsWith("\n\n")).toBe(true);
  });

  test("multiple files: all listed comma-separated", () => {
    const notice = formatOverlapNotice(["a.md", "b.md", "c.md"]);
    expect(notice).toContain("a.md, b.md, c.md");
  });

  test("warning glyph present for agent attention", () => {
    // \u26a0\ufe0f is the emoji-presentation warning sign
    expect(formatOverlapNotice(["x.md"])).toContain("\u26a0\ufe0f");
  });

  test("notice is compact (single paragraph, ~1 sentence)", () => {
    const notice = formatOverlapNotice(["x.md"]);
    // Excluding the leading separator, notice should be < 400 chars —
    // the whole point of systemPrompt injection is to keep the token
    // footprint low on quiet turns.
    expect(notice.trim().length).toBeLessThan(400);
  });

  test("single-file notice token budget upper bound (R10-PERF-4)", () => {
    // R10-PERF-4: pin the per-fire token cost so a future doc-style
    // edit can't double the prefix. The per-completion mechanism
    // (R7-PERF-2) accepts ~5–12 fires/day across active sessions; cost
    // = fires × tokens. Char-count proxy at ~4 chars/token; assert
    // <100 tokens for a single-file notice.
    const notice = formatOverlapNotice(["notes/foo.md"]);
    const estimatedTokens = Math.ceil(notice.length / 4);
    expect(estimatedTokens).toBeLessThan(100);
  });

  test("multi-file notice scales linearly with file count, no surprise overhead", () => {
    // Defensive: a 50-file notice shouldn't be quadratically large.
    // The implementation joins with ', ' so token cost is roughly
    // (fixed prefix) + N × (avg file-path length / 4 chars/token).
    const fixedPart = formatOverlapNotice(["x"]).length;
    const fifty = formatOverlapNotice(
      Array.from({ length: 50 }, (_, i) => `notes/file${i}.md`),
    );
    // Each entry is ~16 chars + ', ' = ~18 chars. 50 × 18 = 900 chars
    // for the file list, plus ~fixedPart for the surrounding text.
    expect(fifty.length).toBeLessThan(fixedPart + 1200);
    // Sanity: 50-file notice still fits in ~400 tokens — well under
    // any reasonable single-message budget. Compaction kicks in if
    // they accumulate over many days.
    expect(Math.ceil(fifty.length / 4)).toBeLessThan(400);
  });
});
