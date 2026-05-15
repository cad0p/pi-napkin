/**
 * Meta-test: pin pi's internal `extractFileOpsFromMessage` location.
 *
 * Our `extractFileOpsFromMessage` in session-touched-files.ts is a
 * reimplementation of pi's internal helper at:
 *   node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/utils.js
 *
 * If pi upstream renames, relocates, or removes that function, our
 * reimplementation can silently drift from truth (tool catalog adds,
 * argument renames, etc.). This test catches such changes at test time so
 * we get an explicit "review and resync" alert rather than mysterious
 * overlap-detection misses in production.
 *
 * Not a behavior test — we don't import or call pi's function. Just a
 * sanity check on file layout + a grep for the function name.
 *
 * If this test fails after a pi version bump:
 *   1. Find the new location or name of extractFileOpsFromMessage.
 *   2. Update the expected path below and the comment in
 *      session-touched-files.ts.
 *   3. Re-compare WRITE_CLASS_TOOLS against the new catalog and update
 *      if needed.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PI_UTILS_PATH = join(
  __dirname,
  "..",
  "..",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "core",
  "compaction",
  "utils.js",
);

describe("pi internal API version pin", () => {
  test("pi-coding-agent still exposes utils.js at the expected path", () => {
    expect(existsSync(PI_UTILS_PATH)).toBe(true);
  });

  test("utils.js still defines `extractFileOpsFromMessage`", () => {
    expect(existsSync(PI_UTILS_PATH)).toBe(true);
    const src = readFileSync(PI_UTILS_PATH, "utf-8");
    expect(src).toContain("extractFileOpsFromMessage");
  });

  test("utils.js still dispatches on `read` / `write` / `edit` tool names", () => {
    const src = readFileSync(PI_UTILS_PATH, "utf-8");
    // Loose checks — any format change here (e.g. pi collapses to a map)
    // still won't flake the test, but a wholesale rename of the tool
    // catalog will. The three names must all appear verbatim.
    expect(src).toMatch(/["']write["']/);
    expect(src).toMatch(/["']edit["']/);
    expect(src).toMatch(/["']read["']/);
  });
});
