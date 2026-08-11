/**
 * Meta-test: pin pi's `sendMessage` extension API and its underlying
 * `SessionManager.appendCustomMessageEntry` method.
 *
 * The per-distill-completion overlap notice mechanism (R7-PERF-2)
 * posts to the parent session via the public extension API:
 *
 *   pi.sendMessage({
 *     customType: "napkin-distill-overlap",
 *     content: formatOverlapNotice(overlap),
 *     display: true,
 *   });
 *
 * `sendMessage` is fire-and-forget (void). It emits `message_start` so
 * the TUI renders the notice live, and it appends the entry via
 * `SessionManager.appendCustomMessageEntry` internally — so that method
 * is still load-bearing here (and remains napkin-context's fallback
 * path). A direct `sm.appendCustomMessageEntry` from the extension
 * would leave the notice invisible in the chat until the next full
 * rebuild (e.g. /reload), which is why the notice posts via
 * `sendMessage` instead.
 *
 * This test pins the upstream surface so a pi version bump that
 * renames / removes / re-shapes either API fires a clean "review and
 * resync" failure rather than silently disabling overlap detection.
 *
 * If this test fails after a pi version bump:
 *   1. Find the new API surface in
 *      node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts
 *      (sendMessage) and dist/core/session-manager.d.ts
 *      (appendCustomMessageEntry).
 *   2. Update `postOverlapNoticeOnCompletion` in extensions/distill/index.ts
 *      to match.
 *   3. Update this test's assertions.
 *
 * R8-CC-2.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

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

const PI_EXTENSION_TYPES_DTS = join(
  __dirname,
  "..",
  "..",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "core",
  "extensions",
  "types.d.ts",
);

describe("pi sendMessage + appendCustomMessageEntry version pin (R7-PERF-2 / R8-CC-2)", () => {
  test("pi-coding-agent still exposes extensions/types.d.ts at the expected path", () => {
    expect(existsSync(PI_EXTENSION_TYPES_DTS)).toBe(true);
  });

  test("ExtensionAPI still declares `sendMessage` with a void return", () => {
    const src = readFileSync(PI_EXTENSION_TYPES_DTS, "utf-8");
    // Pin the member inside the ExtensionAPI interface itself: a bare
    // toContain("sendMessage") would also match ReplacedSessionContext and
    // ExtensionActions, so it wouldn't trip on an ExtensionAPI rename. The
    // `): void` return pin catches a change to Promise<void> — the
    // extension relies on fire-and-forget semantics (no await/.catch).
    expect(src).toMatch(
      /interface ExtensionAPI[\s\S]*?sendMessage<T = unknown>[\(\s\S]*?\): void;/,
    );
  });

  test("SendMessageHandler is fire-and-forget (void) and accepts customType/content/display/details", () => {
    const src = readFileSync(PI_EXTENSION_TYPES_DTS, "utf-8");
    expect(src).toMatch(
      /export type SendMessageHandler = [\s\S]*?=> void;/,
    );
    // Field-name pin, order-independent: a cosmetic reorder of the Pick
    // type-argument list must not trip the tripwire.
    const alias = src.match(
      /export type SendMessageHandler = ([\s\S]*?)=> void;/,
    );
    expect(alias).not.toBeNull();
    if (alias) {
      for (const field of ["customType", "content", "display", "details"]) {
        expect(alias[1]).toContain(`\"${field}\"`);
      }
    }
  });
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
