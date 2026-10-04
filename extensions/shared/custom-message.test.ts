import { describe, expect, test, vi } from "vitest";
import {
  hasCustomMessage,
  sendCustomMessageOnce,
  sendCustomMessageWithFallback,
} from "./custom-message";

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

describe("hasCustomMessage", () => {
  test("true when a custom_message entry with the customType exists", () => {
    const sm = {
      getEntries: () => [
        { type: "message", role: "user" },
        { type: "custom_message", customType: "napkin-context" },
      ],
    };
    expect(hasCustomMessage(sm as never, "napkin-context")).toBe(true);
  });

  test("false when only other customTypes or plain entries are present", () => {
    const sm = {
      getEntries: () => [
        { type: "message", role: "user" },
        { type: "custom_message", customType: "napkin-distill-overlap" },
      ],
    };
    expect(hasCustomMessage(sm as never, "napkin-context")).toBe(false);
  });

  test("false when the session manager or getEntries is absent", () => {
    expect(hasCustomMessage(undefined, "napkin-context")).toBe(false);
    expect(hasCustomMessage({} as never, "napkin-context")).toBe(false);
  });

  test("false (not throwing) when getEntries throws", () => {
    const sm = {
      getEntries: () => {
        throw new Error("unreadable history");
      },
    };
    expect(hasCustomMessage(sm as never, "napkin-context")).toBe(false);
  });
});

describe("sendCustomMessageOnce", () => {
  test("sends and returns true when the customType is absent", () => {
    const sendMessage = vi.fn();
    const sent = sendCustomMessageOnce({
      poster: { sendMessage },
      sm: { getEntries: () => [] } as never,
      customType: "napkin-context",
      content: "notice-text",
    });
    expect(sent).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("dedupes when the customType is already present", () => {
    const sendMessage = vi.fn();
    const sm = {
      getEntries: () => [
        { type: "custom_message", customType: "napkin-context" },
      ],
    };
    const sent = sendCustomMessageOnce({
      poster: { sendMessage },
      sm: sm as never,
      customType: "napkin-context",
      content: "notice-text",
    });
    expect(sent).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
