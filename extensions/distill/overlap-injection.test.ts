/**
 * Unit tests for the `before_agent_start` overlap-injection helpers.
 *
 * The handler itself runs async inside pi's event loop; these tests focus
 * on the pure formatters/computations that drive it so we can verify the
 * output shape without mocking the full `ExtensionAPI`.
 *
 * The session-side file extraction is covered separately in
 * `session-touched-files.test.ts`; the distill-side `diffWorktreeSinceStart`
 * is covered in `distill-workspace.test.ts`. Here we test the intersection
 * + message formatting.
 *
 * Handler wiring (env-guarded, vault-resolve, early-returns) is covered
 * indirectly \u2014 it's a thin adapter over these pure helpers.
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
    // Known false-positive shape \u2014 two `README.md`s in different dirs.
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
  test("empty overlap: empty string (0-token \u2018quiet\u2019 case)", () => {
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
    // Excluding the leading separator, notice should be < 400 chars \u2014
    // the whole point of systemPrompt injection is to keep the token
    // footprint low on quiet turns.
    expect(notice.trim().length).toBeLessThan(400);
  });
});
