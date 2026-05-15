/**
 * Meta-test: pin pi's `SessionManager.appendCustomMessageEntry` method.
 *
 * The per-distill-completion overlap notice mechanism (R7-PERF-2)
 * posts to the parent session via:
 *
 *   sm.appendCustomMessageEntry(
 *     "napkin-distill-overlap",
 *     formatOverlapNotice(overlap),
 *     true, // display
 *   );
 *
 * `appendCustomMessageEntry` is on `SessionManager` but NOT on the
 * `ReadonlySessionManager` type that pi exposes via `ExtensionContext`.
 * We cast through `Partial<SessionManager>` and gate the call on
 * `typeof sm.appendCustomMessageEntry === "function"` (matching the
 * `napkin-context` extension's pattern). That runtime guard means an
 * upstream rename or removal of this method would disable the overlap
 * notice mechanism entirely with ZERO production signal — the agent
 * just stops getting overlap warnings.
 *
 * This test pins the upstream surface so a pi version bump that
 * renames / removes / re-shapes the method fires a clean "review and
 * resync" failure rather than silently disabling overlap detection.
 *
 * Mirrors `session-touched-files.version-check.test.ts` for pi's
 * `extractFileOpsFromMessage` internal.
 *
 * If this test fails after a pi version bump:
 *   1. Find the new method name / signature in
 *      node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts.
 *   2. Update `postOverlapNoticeOnCompletion` in extensions/distill/index.ts
 *      to match.
 *   3. Update this test's assertions.
 *
 * R8-CC-2.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PI_SESSION_MANAGER_DTS = join(
  __dirname,
  "..",
  "..",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "core",
  "session-manager.d.ts",
);

const PI_SESSION_MANAGER_JS = join(
  __dirname,
  "..",
  "..",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "core",
  "session-manager.js",
);

describe("pi appendCustomMessageEntry version pin (R7-PERF-2 / R8-CC-2)", () => {
  test("pi-coding-agent still exposes session-manager.d.ts at the expected path", () => {
    expect(existsSync(PI_SESSION_MANAGER_DTS)).toBe(true);
  });

  test("session-manager.d.ts still declares `appendCustomMessageEntry`", () => {
    const src = readFileSync(PI_SESSION_MANAGER_DTS, "utf-8");
    expect(src).toContain("appendCustomMessageEntry");
  });

  test("session-manager.d.ts signature accepts (customType, content, display, details?)", () => {
    const src = readFileSync(PI_SESSION_MANAGER_DTS, "utf-8");
    // Loose matcher — pi's exact whitespace / type-arg layout may shift
    // across versions but the four parameters in this order are the
    // contract our call site relies on. The `[\s\S]*?` accommodates the
    // optional generic prefix `<T = unknown>` between the method name
    // and the opening parenthesis.
    expect(src).toMatch(
      /appendCustomMessageEntry[\s\S]*?\([^)]*customType:\s*string,[\s\S]*?content:[\s\S]*?display:\s*boolean/,
    );
  });

  test("session-manager.js implementation is still present", () => {
    // Belt-and-braces: the .d.ts declaration could in theory survive a
    // refactor that drops the runtime implementation. Pin both.
    expect(existsSync(PI_SESSION_MANAGER_JS)).toBe(true);
    const src = readFileSync(PI_SESSION_MANAGER_JS, "utf-8");
    expect(src).toContain("appendCustomMessageEntry");
  });

  test("appendCustomMessageEntry is on SessionManager class, NOT ReadonlySessionManager", () => {
    // The runtime guard `typeof sm.appendCustomMessageEntry === \"function\"`
    // exists because pi's ExtensionContext narrows sessionManager to
    // ReadonlySessionManager (which omits mutation methods). At runtime
    // it's the full SessionManager. If pi ever moves the method onto
    // the readonly type, the cast becomes unnecessary; if pi tightens
    // the runtime to actually be a readonly proxy, the call would
    // silently no-op. Either way we want a signal.
    const src = readFileSync(PI_SESSION_MANAGER_DTS, "utf-8");
    // ReadonlySessionManager is defined in the same .d.ts as
    // `Pick<SessionManager, ...>` listing only read-only methods. Find
    // the pick list and assert appendCustomMessageEntry is NOT in it.
    const readonlyPickMatch = src.match(
      /ReadonlySessionManager\s*=\s*Pick<SessionManager,\s*([^>]+)>/,
    );
    expect(readonlyPickMatch).not.toBeNull();
    if (readonlyPickMatch) {
      const pickedMethods = readonlyPickMatch[1];
      expect(pickedMethods).not.toContain("appendCustomMessageEntry");
    }
  });
});
