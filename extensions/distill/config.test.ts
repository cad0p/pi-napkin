import { describe, expect, it } from "bun:test";
import {
  getDistillConfig,
  MalformedDistillConfigError,
  DEFAULT_DISTILL,
} from "./index.js";

describe("getDistillConfig", () => {
  it("returns defaults when distill section is missing", () => {
    const result = getDistillConfig({} as any);
    expect(result.distill).toEqual(DEFAULT_DISTILL);
    expect(result.showStatus).toBe(true);
  });

  it("merges distill section with defaults", () => {
    const config = {
      distill: { enabled: true, intervalMinutes: 30 },
    } as any;
    const result = getDistillConfig(config);
    expect(result.distill.enabled).toBe(true);
    expect(result.distill.intervalMinutes).toBe(30);
    // Defaults preserved
    expect(result.distill.onShutdown).toBe(DEFAULT_DISTILL.onShutdown);
  });

  it("throws MalformedDistillConfigError when distill is not an object", () => {
    const config = { distill: "not an object" } as any;
    expect(() => getDistillConfig(config)).toThrow(MalformedDistillConfigError);
  });

  it("throws MalformedDistillConfigError when enabled is not a boolean", () => {
    const config = { distill: { enabled: "yes" } } as any;
    expect(() => getDistillConfig(config)).toThrow(MalformedDistillConfigError);
  });

  it("throws MalformedDistillConfigError when intervalMinutes is not a number", () => {
    const config = { distill: { intervalMinutes: "thirty" } } as any;
    expect(() => getDistillConfig(config)).toThrow(MalformedDistillConfigError);
  });

  it("throws MalformedDistillConfigError when model is malformed", () => {
    const config = { distill: { model: { provider: "openai" } } } as any;
    expect(() => getDistillConfig(config)).toThrow(MalformedDistillConfigError);
  });

  it("accepts valid model config", () => {
    const config = {
      distill: {
        model: { provider: "openai", id: "gpt-4o" },
      },
    } as any;
    const result = getDistillConfig(config);
    expect(result.distill.model).toEqual({
      provider: "openai",
      id: "gpt-4o",
    });
  });

  it("respects showStatus field", () => {
    const config = { showStatus: false } as any;
    const result = getDistillConfig(config);
    expect(result.showStatus).toBe(false);
  });

  it("includes configPath in error when provided", () => {
    const config = { distill: "bad" } as any;
    try {
      getDistillConfig(config, "/path/to/config.json");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MalformedDistillConfigError);
      expect((err as MalformedDistillConfigError).configPath).toBe(
        "/path/to/config.json",
      );
    }
  });
});
