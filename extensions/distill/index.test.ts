import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DISTILL_PROMPT_CACHE_KEY_ENV } from "./distill-workspace";
import {
  applyDistillPromptCacheKey,
  DEFAULT_DISTILL,
  formatOutcomeNotification,
  formatVaultConfigParseError,
  loadVaultConfig,
  MalformedVaultConfigError,
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

describe("applyDistillPromptCacheKey", () => {
  const saved = process.env[DISTILL_PROMPT_CACHE_KEY_ENV];

  afterEach(() => {
    if (saved === undefined) delete process.env[DISTILL_PROMPT_CACHE_KEY_ENV];
    else process.env[DISTILL_PROMPT_CACHE_KEY_ENV] = saved;
  });

  test("patches OpenAI-style payload prompt_cache_key from env", () => {
    process.env[DISTILL_PROMPT_CACHE_KEY_ENV] = "parent-session-id";
    expect(
      applyDistillPromptCacheKey({
        model: "gpt-5.1",
        prompt_cache_key: "fork-session-id",
        input: [],
      }),
    ).toEqual({
      model: "gpt-5.1",
      prompt_cache_key: "parent-session-id",
      input: [],
    });
  });

  test("leaves payloads without a concrete prompt_cache_key unchanged", () => {
    process.env[DISTILL_PROMPT_CACHE_KEY_ENV] = "parent-session-id";
    expect(applyDistillPromptCacheKey({ model: "claude", messages: [] })).toBe(
      undefined,
    );
    expect(
      applyDistillPromptCacheKey({ model: "gpt", prompt_cache_key: undefined }),
    ).toBe(undefined);
  });
});

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

  test("malformed JSON throws MalformedVaultConfigError with parse detail", () => {
    const vault = track(makeVault("{ not valid json"));
    let thrown: unknown = null;
    try {
      loadVaultConfig(vault);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MalformedVaultConfigError);
    const e = thrown as MalformedVaultConfigError;
    expect(e.configPath).toBe(path.join(vault, "config.json"));
    expect(e.parseError.length).toBeGreaterThan(0);
    // Make sure the underlying message embeds the path so notify-text
    // surfaces a user-actionable file location.
    expect(e.message).toContain("config.json");
  });

  test("missing config.json still returns DEFAULT (no throw)", () => {
    // Counterfactual to the malformed-JSON throw: the missing-file
    // path stays fail-soft so a fresh vault before `napkin init` is
    // still usable inside pi.
    const vault = track(makeVault(null));
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

describe("formatVaultConfigParseError", () => {
  // The user-facing notify text embeds the parse-error verbatim.
  // JSON.parse messages are usually short, but a malformed multi-MB
  // config.json can produce a parse error long enough to overflow the
  // notify surface. The formatter caps the embedded text to a
  // bounded length while leaving the unbounded value on the error
  // object for callers that want to log it.

  test("short parse error: returned unchanged", () => {
    const short = "Unexpected token } in JSON at position 42";
    expect(formatVaultConfigParseError(short)).toBe(short);
  });

  test("1 KB parse error: bounded with truncation suffix, total length under 300 chars", () => {
    // Adversarial input: a 1 KB parse-error message. The cap
    // constant is 200; the formatter appends a short truncation
    // suffix. We assert the total fits comfortably in a single
    // notify line (≤ 300 chars covers the cap + suffix without
    // pinning the exact suffix wording).
    const longParseError = "x".repeat(1024);
    const formatted = formatVaultConfigParseError(longParseError);
    expect(formatted.length).toBeLessThan(300);
    expect(formatted.length).toBeLessThan(longParseError.length);
    // Truncation marker is present so the user can tell the message
    // was clipped.
    expect(formatted).toContain("truncated");
  });

  test("empty parse error: returned unchanged", () => {
    expect(formatVaultConfigParseError("")).toBe("");
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
