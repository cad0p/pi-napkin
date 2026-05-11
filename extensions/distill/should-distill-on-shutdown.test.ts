import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SessionShutdownEvent } from "@mariozechner/pi-coding-agent";

import {
  type ShouldDistillOnShutdownConfig,
  shouldDistillOnShutdown,
} from "./should-distill-on-shutdown";

/**
 * Default inputs that produce `true`. Each test below flips ONE input at a
 * time and asserts the expected guard fires, proving guard isolation and
 * guard order (earlier guards short-circuit later ones).
 *
 * Types are widened to the predicate's parameter types (not narrowed to the
 * literal values below) so `call({...})` overrides don't collide with the
 * inferred literal types.
 */
interface Inputs {
  event: Pick<SessionShutdownEvent, "reason">;
  config: ShouldDistillOnShutdownConfig;
  autoDistillSuppressed: boolean;
  sessionFile: string | undefined | null;
  currentSize: number;
  lastSpawnedSize: number;
  lastSessionSize: number;
}

const DEFAULTS: Inputs = {
  // pi 0.68+ guarantees a `reason` field \u2014 the baseline uses "quit" since that's the
  // common path that should distill. Guard 2 (reload) is tested by overriding.
  event: { reason: "quit" },
  config: {
    enabled: true,
    onShutdown: true,
  },
  autoDistillSuppressed: false,
  sessionFile: "/tmp/session.jsonl",
  currentSize: 1024,
  lastSpawnedSize: 0,
  lastSessionSize: 0,
};

function call(overrides: Partial<Inputs> = {}): boolean {
  const i = { ...DEFAULTS, ...overrides };
  return shouldDistillOnShutdown(
    i.event,
    i.config,
    i.autoDistillSuppressed,
    i.sessionFile,
    i.currentSize,
    i.lastSpawnedSize,
    i.lastSessionSize,
  );
}

describe("shouldDistillOnShutdown", () => {
  // Clear the recursion-guard env var before every test — the test runner may
  // itself be running inside a distill subprocess (NAPKIN_DISTILL_NO_RECURSE=1).
  const _savedRecurse = process.env.NAPKIN_DISTILL_NO_RECURSE;
  beforeEach(() => { delete process.env.NAPKIN_DISTILL_NO_RECURSE; });
  afterEach(() => {
    if (_savedRecurse !== undefined) process.env.NAPKIN_DISTILL_NO_RECURSE = _savedRecurse;
    else delete process.env.NAPKIN_DISTILL_NO_RECURSE;
  });

  test("baseline: all guards pass \u2192 true", () => {
    expect(call()).toBe(true);
  });

  describe("guard 1: NAPKIN_DISTILL_NO_RECURSE", () => {
    const originalEnv = process.env.NAPKIN_DISTILL_NO_RECURSE;

    beforeEach(() => {
      delete process.env.NAPKIN_DISTILL_NO_RECURSE;
    });

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.NAPKIN_DISTILL_NO_RECURSE;
      } else {
        process.env.NAPKIN_DISTILL_NO_RECURSE = originalEnv;
      }
    });

    test("env var set \u2192 false (recursion guard)", () => {
      process.env.NAPKIN_DISTILL_NO_RECURSE = "1";
      expect(call()).toBe(false);
    });

    test("env var set to empty string \u2192 false-ish: empty string is falsy, so guard does NOT fire", () => {
      // Node treats empty env strings as truthy for presence checks via
      // `process.env.X === undefined`, but our guard uses truthiness
      // (`if (process.env.X) return false`). An empty string is falsy \u2192
      // guard does not fire. This is the intentional behavior: empty means
      // "unset" at our abstraction layer.
      process.env.NAPKIN_DISTILL_NO_RECURSE = "";
      expect(call()).toBe(true);
    });

    test("env var set to any truthy value \u2192 false", () => {
      process.env.NAPKIN_DISTILL_NO_RECURSE = "whatever";
      expect(call()).toBe(false);
    });

    test("env var unset \u2192 later guards run", () => {
      expect(call()).toBe(true);
    });

    test("env var short-circuits ALL later guards (even disabled config)", () => {
      process.env.NAPKIN_DISTILL_NO_RECURSE = "1";
      expect(call({ config: { enabled: false, onShutdown: true } })).toBe(
        false,
      );
    });
  });

  describe("guard 2: event.reason === reload", () => {
    test('reason === "reload" \u2192 false', () => {
      expect(call({ event: { reason: "reload" } })).toBe(false);
    });

    test('reason === "quit" \u2192 true (not a reload)', () => {
      expect(call({ event: { reason: "quit" } })).toBe(true);
    });

    test("reason non-reload canonical values \u2192 true", () => {
      // pi 0.68+ types `reason` as a literal union of these five values. Only
      // "reload" short-circuits; the rest all allow distill.
      for (const reason of ["quit", "new", "resume", "fork"] as const) {
        expect(call({ event: { reason } })).toBe(true);
      }
    });
  });

  describe("guard 3: autoDistillSuppressed", () => {
    test("autoDistillSuppressed=true \u2192 false", () => {
      expect(call({ autoDistillSuppressed: true })).toBe(false);
    });

    test("autoDistillSuppressed=false \u2192 true", () => {
      expect(call({ autoDistillSuppressed: false })).toBe(true);
    });
  });

  describe("guard 4: config.enabled", () => {
    test("enabled=false \u2192 false (master switch off)", () => {
      expect(call({ config: { enabled: false, onShutdown: true } })).toBe(
        false,
      );
    });

    test("enabled=true \u2192 true", () => {
      expect(call({ config: { enabled: true, onShutdown: true } })).toBe(true);
    });
  });

  describe("guard 5: config.onShutdown opt-out", () => {
    test("onShutdown=false \u2192 false", () => {
      expect(call({ config: { enabled: true, onShutdown: false } })).toBe(
        false,
      );
    });

    test("onShutdown=true \u2192 true", () => {
      expect(call({ config: { enabled: true, onShutdown: true } })).toBe(true);
    });

    test("onShutdown is strict === false \u2014 truthy values allow run", () => {
      // Guard is `config.onShutdown === false`. Non-false values (null,
      // undefined, strings) do NOT trigger opt-out. This is explicit in the
      // spec: malformed config defaults to enabled.
      for (const truthy of [
        undefined,
        null,
        "no" as unknown,
        0 as unknown,
        1 as unknown,
      ]) {
        expect(
          call({
            config: {
              enabled: true,
              // biome-ignore lint/suspicious/noExplicitAny: intentionally testing malformed values
              onShutdown: truthy as any,
            },
          }),
        ).toBe(true);
      }
    });
  });

  describe("guard 6: sessionFile required", () => {
    test("sessionFile=undefined \u2192 false (ephemeral)", () => {
      expect(call({ sessionFile: undefined })).toBe(false);
    });

    test("sessionFile=null \u2192 false (ephemeral)", () => {
      expect(call({ sessionFile: null })).toBe(false);
    });

    test('sessionFile="" \u2192 false (falsy)', () => {
      expect(call({ sessionFile: "" })).toBe(false);
    });

    test("sessionFile non-empty \u2192 true", () => {
      expect(call({ sessionFile: "/tmp/s.jsonl" })).toBe(true);
    });
  });

  describe("guard 7: currentSize === 0", () => {
    test("currentSize=0 \u2192 false", () => {
      expect(call({ currentSize: 0 })).toBe(false);
    });

    test("currentSize=1 \u2192 true", () => {
      expect(call({ currentSize: 1 })).toBe(true);
    });
  });

  describe("guard 8: currentSize === lastSpawnedSize", () => {
    test("matching \u2192 false (interval distill just spawned with this content)", () => {
      expect(
        call({
          currentSize: 2048,
          lastSpawnedSize: 2048,
          lastSessionSize: 0,
        }),
      ).toBe(false);
    });

    test("currentSize > lastSpawnedSize \u2192 true (new content since last spawn)", () => {
      expect(
        call({
          currentSize: 3000,
          lastSpawnedSize: 2048,
          lastSessionSize: 0,
        }),
      ).toBe(true);
    });

    test("lastSpawnedSize=0 (never spawned) and currentSize>0 \u2192 true", () => {
      expect(call({ currentSize: 500, lastSpawnedSize: 0 })).toBe(true);
    });
  });

  describe("guard 9: currentSize === lastSessionSize", () => {
    test("matching \u2192 false (last completed distill captured this exact size)", () => {
      expect(
        call({
          currentSize: 2048,
          lastSpawnedSize: 0,
          lastSessionSize: 2048,
        }),
      ).toBe(false);
    });

    test("currentSize > lastSessionSize \u2192 true", () => {
      expect(
        call({
          currentSize: 3000,
          lastSpawnedSize: 0,
          lastSessionSize: 2048,
        }),
      ).toBe(true);
    });

    test("lastSessionSize=0 (never completed) and currentSize>0 \u2192 true", () => {
      expect(call({ currentSize: 500, lastSessionSize: 0 })).toBe(true);
    });
  });

  describe("integration scenarios", () => {
    test("typical /quit with new content \u2192 true", () => {
      expect(
        call({
          event: { reason: "quit" },
          currentSize: 5000,
          lastSpawnedSize: 3000,
          lastSessionSize: 3000,
        }),
      ).toBe(true);
    });

    test("/reload \u2192 false (even with new content, even with everything enabled)", () => {
      expect(
        call({
          event: { reason: "reload" },
          currentSize: 5000,
          lastSpawnedSize: 3000,
          lastSessionSize: 3000,
        }),
      ).toBe(false);
    });

    test("just-spawned dedup: interval fired at t=55m, user /quits at t=55m01s before anything happens \u2192 false", () => {
      expect(
        call({
          event: { reason: "quit" },
          currentSize: 4096,
          lastSpawnedSize: 4096,
          lastSessionSize: 3000,
        }),
      ).toBe(false);
    });

    test("just-spawned-then-new-content: interval fired at t=55m (S1=4096), user types, /quits at S2=4200 \u2192 true (worktree dedup handles A+B)", () => {
      expect(
        call({
          event: { reason: "quit" },
          currentSize: 4200,
          lastSpawnedSize: 4096,
          lastSessionSize: 0,
        }),
      ).toBe(true);
    });

    test("shutdown right after completed distill \u2192 false (already captured)", () => {
      expect(
        call({
          event: { reason: "quit" },
          currentSize: 4096,
          lastSpawnedSize: 4096,
          lastSessionSize: 4096,
        }),
      ).toBe(false);
    });

    test("fresh session with no content at /quit \u2192 false", () => {
      expect(
        call({
          event: { reason: "quit" },
          currentSize: 0,
        }),
      ).toBe(false);
    });

    test("vault with distill disabled \u2192 false regardless of anything else", () => {
      expect(
        call({
          event: { reason: "quit" },
          config: { enabled: false, onShutdown: true },
          currentSize: 9999,
          lastSpawnedSize: 0,
          lastSessionSize: 0,
        }),
      ).toBe(false);
    });

    test("vault enabled but onShutdown opted out \u2192 false", () => {
      expect(
        call({
          event: { reason: "quit" },
          config: { enabled: true, onShutdown: false },
          currentSize: 9999,
        }),
      ).toBe(false);
    });

    test("/distill-auto-this-session off \u2192 false (shutdown respects session toggle)", () => {
      expect(
        call({
          event: { reason: "quit" },
          autoDistillSuppressed: true,
          currentSize: 9999,
        }),
      ).toBe(false);
    });
  });

  describe("guard order (early guards short-circuit later)", () => {
    test("recursion guard beats reload guard", () => {
      const originalEnv = process.env.NAPKIN_DISTILL_NO_RECURSE;
      try {
        process.env.NAPKIN_DISTILL_NO_RECURSE = "1";
        expect(call({ event: { reason: "reload" } })).toBe(false);
      } finally {
        if (originalEnv === undefined) {
          delete process.env.NAPKIN_DISTILL_NO_RECURSE;
        } else {
          process.env.NAPKIN_DISTILL_NO_RECURSE = originalEnv;
        }
      }
    });

    test("reload guard beats enabled-config guard", () => {
      expect(
        call({
          event: { reason: "reload" },
          config: { enabled: false, onShutdown: true },
        }),
      ).toBe(false);
    });

    test("disabled config beats content-delta guards", () => {
      // Would otherwise be `true` via "new content" but master switch off.
      expect(
        call({
          config: { enabled: false, onShutdown: true },
          currentSize: 5000,
        }),
      ).toBe(false);
    });
  });
});
