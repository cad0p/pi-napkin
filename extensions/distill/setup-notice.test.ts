import { describe, expect, test } from "vitest";

import type { NapkinCliProbeResult } from "./auto-setup";
import {
  formatNapkinSetupNotice,
  maybeInjectNapkinSetupNotice,
  NAPKIN_SETUP_NOTICE_CUSTOM_TYPE,
} from "./setup-notice";

/**
 * Delivery is delegated to `sendCustomMessageWithFallback`, which only
 * needs `sendMessage` on the poster and `appendCustomMessageEntry` on
 * the session manager. The fakes below satisfy exactly that surface;
 * the casts at the call sites keep the test independent of pi's full
 * API types.
 */
function makeFakePoster(options: { throws?: boolean } = {}) {
  const sent: Array<{
    customType: string;
    content: string;
    display?: boolean;
  }> = [];
  const poster = {
    sendMessage: (message: {
      customType: string;
      content: string;
      display?: boolean;
    }) => {
      if (options.throws) throw new Error("runtime invalidated");
      sent.push(message);
    },
  };
  return { poster, sent };
}

function makeFakeSm(
  options: {
    entries?: unknown[];
    getEntriesThrows?: boolean;
    appendThrows?: boolean;
  } = {},
) {
  const appended: Array<{ customType: string; content: string }> = [];
  const sm = {
    getEntries: () => {
      if (options.getEntriesThrows) throw new Error("unreadable history");
      return options.entries ?? [];
    },
    appendCustomMessageEntry: (customType: string, content: string) => {
      if (options.appendThrows) throw new Error("append failed");
      appended.push({ customType, content });
    },
  };
  return { sm, appended };
}

function inject(options: {
  poster: ReturnType<typeof makeFakePoster>["poster"];
  sm: ReturnType<typeof makeFakeSm>["sm"] | undefined;
  probe: NapkinCliProbeResult;
  onFallbackFailure?: (err: unknown) => void;
}): void {
  maybeInjectNapkinSetupNotice({
    poster: options.poster as never,
    sm: options.sm as never,
    probe: options.probe,
    onFallbackFailure: options.onFallbackFailure,
  });
}

describe("formatNapkinSetupNotice", () => {
  test("wraps the failure and install commands in the delimiting tag", () => {
    const text = formatNapkinSetupNotice("not found on PATH");
    expect(text.startsWith("<napkin-distill-setup>")).toBe(true);
    expect(text.endsWith("</napkin-distill-setup>")).toBe(true);
    expect(text).toContain("not found on PATH");
    // Both documented install paths, plus the verification step.
    expect(text).toContain("pnpm add -g @cad0p/napkin");
    expect(text).toContain("npm install -g @cad0p/napkin");
    expect(text).toContain("napkin --version");
  });

  test("tolerates a missing error detail", () => {
    expect(formatNapkinSetupNotice(undefined)).toContain("unknown error");
  });
});

describe("maybeInjectNapkinSetupNotice", () => {
  test("healthy probe: no message", () => {
    const { poster, sent } = makeFakePoster();
    const { sm } = makeFakeSm();
    inject({ poster, sm, probe: { ok: true, path: "/usr/bin/napkin" } });
    expect(sent).toEqual([]);
  });

  test("failed probe: sends the notice custom message with display=true", () => {
    const { poster, sent } = makeFakePoster();
    inject({
      poster,
      sm: undefined,
      probe: { ok: false, error: "not found on PATH" },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].customType).toBe(NAPKIN_SETUP_NOTICE_CUSTOM_TYPE);
    expect(sent[0].display).toBe(true);
    expect(sent[0].content).toContain("not found on PATH");
    expect(sent[0].content).toContain("@cad0p/napkin");
  });

  test("dedupes when the session already carries the notice", () => {
    const { poster, sent } = makeFakePoster();
    const { sm } = makeFakeSm({
      entries: [
        { type: "custom_message", customType: NAPKIN_SETUP_NOTICE_CUSTOM_TYPE },
      ],
    });
    inject({ poster, sm, probe: { ok: false, error: "not found on PATH" } });
    expect(sent).toEqual([]);
  });

  test("unrelated custom messages do not suppress the notice", () => {
    const { poster, sent } = makeFakePoster();
    const { sm } = makeFakeSm({
      entries: [{ type: "custom_message", customType: "napkin-context" }],
    });
    inject({ poster, sm, probe: { ok: false, error: "not found on PATH" } });
    expect(sent).toHaveLength(1);
  });

  test("unreadable session history still injects", () => {
    const { poster, sent } = makeFakePoster();
    const { sm } = makeFakeSm({ getEntriesThrows: true });
    inject({ poster, sm, probe: { ok: false, error: "not found on PATH" } });
    expect(sent).toHaveLength(1);
  });

  test("falls back to a direct session append when sendMessage throws", () => {
    const { poster } = makeFakePoster({ throws: true });
    const { sm, appended } = makeFakeSm();
    inject({ poster, sm, probe: { ok: false, error: "not found on PATH" } });
    expect(appended).toHaveLength(1);
    expect(appended[0].customType).toBe(NAPKIN_SETUP_NOTICE_CUSTOM_TYPE);
    expect(appended[0].content).toContain("@cad0p/napkin");
  });

  test("onFallbackFailure fires when both delivery paths fail", () => {
    const { poster } = makeFakePoster({ throws: true });
    const { sm } = makeFakeSm({ appendThrows: true });
    const failures: unknown[] = [];
    inject({
      poster,
      sm,
      probe: { ok: false, error: "not found on PATH" },
      onFallbackFailure: (err) => failures.push(err),
    });
    expect(failures).toHaveLength(1);
  });
});
