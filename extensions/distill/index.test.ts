import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_DISTILL,
  formatOutcomeNotification,
  loadVaultConfig,
} from "./index";

/**
 * Writes a vault config.json and returns its parent dir (the vault path to
 * feed `loadVaultConfig`).
 */
function makeVault(configJson: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-napkin-test-"));
  if (configJson !== null) {
    fs.writeFileSync(path.join(dir, "config.json"), configJson);
  }
  return dir;
}

describe("loadVaultConfig", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    tempDirs.length = 0;
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function track(dir: string): string {
    tempDirs.push(dir);
    return dir;
  }

  test("missing config.json returns defaults", () => {
    const vault = track(makeVault(null));
    const cfg = loadVaultConfig(vault);
    expect(cfg.distill).toEqual(DEFAULT_DISTILL);
    expect(cfg.showStatus).toBe(true);
  });

  test("empty distill block keeps all defaults, including onShutdown=true", () => {
    const vault = track(makeVault(JSON.stringify({ distill: {} })));
    const cfg = loadVaultConfig(vault);
    expect(cfg.distill.onShutdown).toBe(true);
    expect(cfg.distill.enabled).toBe(false);
    expect(cfg.distill.intervalMinutes).toBe(60);
  });

  test("distill.onShutdown=false opts out explicitly", () => {
    const vault = track(
      makeVault(
        JSON.stringify({ distill: { enabled: true, onShutdown: false } }),
      ),
    );
    const cfg = loadVaultConfig(vault);
    expect(cfg.distill.onShutdown).toBe(false);
    expect(cfg.distill.enabled).toBe(true);
  });

  test("distill.onShutdown=true is preserved (redundant with default)", () => {
    const vault = track(
      makeVault(
        JSON.stringify({ distill: { enabled: true, onShutdown: true } }),
      ),
    );
    const cfg = loadVaultConfig(vault);
    expect(cfg.distill.onShutdown).toBe(true);
  });

  test("missing onShutdown falls back to default=true", () => {
    const vault = track(
      makeVault(JSON.stringify({ distill: { enabled: true } })),
    );
    const cfg = loadVaultConfig(vault);
    expect(cfg.distill.onShutdown).toBe(true);
  });

  // Malformed values: the loader doesn't validate types \u2014 it spreads raw JSON
  // over defaults. The guard in shouldDistillOnShutdown is `=== false`, which
  // means only literal `false` opts out. Anything else (null, strings,
  // numbers) ends up as "not-exactly-false" and the shutdown distill still
  // runs. That's the safe default: malformed config leaves behavior enabled.
  test("distill.onShutdown=null passes through (not === false \u2192 still runs)", () => {
    const vault = track(
      makeVault(JSON.stringify({ distill: { onShutdown: null } })),
    );
    const cfg = loadVaultConfig(vault);
    expect(cfg.distill.onShutdown).toBeNull();
    expect(cfg.distill.onShutdown === false).toBe(false);
  });

  test('distill.onShutdown="off" (string) passes through (not === false)', () => {
    const vault = track(
      makeVault(JSON.stringify({ distill: { onShutdown: "off" } })),
    );
    const cfg = loadVaultConfig(vault);
    expect(cfg.distill.onShutdown).toBe("off" as unknown as boolean);
    expect(cfg.distill.onShutdown === false).toBe(false);
  });

  test("distill.onShutdown=0 (falsy number) passes through (not === false)", () => {
    const vault = track(
      makeVault(JSON.stringify({ distill: { onShutdown: 0 } })),
    );
    const cfg = loadVaultConfig(vault);
    expect(cfg.distill.onShutdown).toBe(0 as unknown as boolean);
    expect(cfg.distill.onShutdown === false).toBe(false);
  });

  test("malformed JSON falls back to defaults", () => {
    const vault = track(makeVault("{ not valid json"));
    const cfg = loadVaultConfig(vault);
    expect(cfg.distill).toEqual(DEFAULT_DISTILL);
    expect(cfg.showStatus).toBe(true);
  });

  test("preserves other distill fields when setting onShutdown", () => {
    const vault = track(
      makeVault(
        JSON.stringify({
          distill: {
            enabled: true,
            intervalMinutes: 30,
            onShutdown: false,
            model: { provider: "kiro", id: "claude-sonnet-4-6" },
          },
        }),
      ),
    );
    const cfg = loadVaultConfig(vault);
    expect(cfg.distill.enabled).toBe(true);
    expect(cfg.distill.intervalMinutes).toBe(30);
    expect(cfg.distill.onShutdown).toBe(false);
    expect(cfg.distill.model).toEqual({
      provider: "kiro",
      id: "claude-sonnet-4-6",
    });
  });
});

describe("formatOutcomeNotification (POST-CONV-5)", () => {
  test("missing sidecar → abnormal-termination warning", () => {
    const r = formatOutcomeNotification({ outcome: null, elapsedSec: 12 });
    expect(r.level).toBe("warning");
    expect(r.message).toBe(
      "Distillation terminated abnormally \u2014 no outcome record",
    );
    expect(r.statusKey).toBe("warning");
    expect(r.statusText).toContain("abnormal");
  });

  test("merged-content → info + elapsed seconds", () => {
    const r = formatOutcomeNotification({
      outcome: { outcomeClass: "merged-content", recoveryHint: null },
      elapsedSec: 42,
    });
    expect(r.level).toBe("info");
    expect(r.message).toBe("Distillation complete (42s)");
    expect(r.statusKey).toBe("success");
    expect(r.statusText).toContain("42s");
  });

  test("no-content → warning", () => {
    const r = formatOutcomeNotification({
      outcome: { outcomeClass: "no-content", recoveryHint: null },
      elapsedSec: 5,
    });
    expect(r.level).toBe("warning");
    expect(r.message).toBe("Distillation ran but saved no content");
    expect(r.statusKey).toBe("warning");
  });

  test("unknown class → defensive warning with class verbatim", () => {
    const r = formatOutcomeNotification({
      outcome: {
        outcomeClass: "weird-future-class",
        recoveryHint: null,
      },
      elapsedSec: 7,
    });
    expect(r.level).toBe("warning");
    expect(r.message).toContain("weird-future-class");
  });
});
