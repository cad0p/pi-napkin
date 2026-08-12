import { describe, expect, test, vi } from "vitest";
import { sendCustomMessageWithFallback } from "./custom-message";

describe("sendCustomMessageWithFallback", () => {
  test("posts via sendMessage with the custom message payload", () => {
    const sendMessage = vi.fn();
    sendCustomMessageWithFallback({
      poster: { sendMessage },
      sm: undefined,
      customType: "napkin-test",
      content: "notice-text",
      display: true,
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      customType: "napkin-test",
      content: "notice-text",
      display: true,
    });
  });

  test("display defaults to true (surface in TUI)", () => {
    const sendMessage = vi.fn();
    sendCustomMessageWithFallback({
      poster: { sendMessage },
      sm: undefined,
      customType: "napkin-test",
      content: "notice-text",
    });
    expect(sendMessage).toHaveBeenCalledWith({
      customType: "napkin-test",
      content: "notice-text",
      display: true,
    });
  });

  test("falls back to a direct session-manager append when sendMessage throws", () => {
    const sendMessage = vi.fn(() => {
      throw new Error("stale runtime");
    });
    const appendCustomMessageEntry = vi.fn();
    sendCustomMessageWithFallback({
      poster: { sendMessage },
      sm: { appendCustomMessageEntry },
      customType: "napkin-test",
      content: "notice-text",
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(appendCustomMessageEntry).toHaveBeenCalledWith(
      "napkin-test",
      "notice-text",
      true,
    );
  });

  test("silently no-ops when sendMessage throws and the append method is absent", () => {
    const sendMessage = vi.fn(() => {
      throw new Error("stale runtime");
    });
    expect(() =>
      sendCustomMessageWithFallback({
        poster: { sendMessage },
        sm: {},
        customType: "napkin-test",
        content: "notice-text",
      }),
    ).not.toThrow();
  });

  test("invokes onFallbackFailure when the direct append throws (best-effort)", () => {
    const sendMessage = vi.fn(() => {
      throw new Error("stale runtime");
    });
    const appendCustomMessageEntry = vi.fn(() => {
      throw new Error("readonly manager");
    });
    const onFallbackFailure = vi.fn();
    expect(() =>
      sendCustomMessageWithFallback({
        poster: { sendMessage },
        sm: { appendCustomMessageEntry },
        customType: "napkin-test",
        content: "notice-text",
        onFallbackFailure,
      }),
    ).not.toThrow();
    expect(onFallbackFailure).toHaveBeenCalledTimes(1);
  });
});
