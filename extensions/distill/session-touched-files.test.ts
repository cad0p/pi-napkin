/**
 * Unit tests for `session-touched-files.ts`.
 *
 * Covers:
 *   - extractFileOpsFromMessage for representative tool shapes (Write, Edit,
 *     bash with redirection)
 *   - Deduplication + ordering invariants of getSessionTouchedFiles
 *   - Empty / non-assistant / malformed inputs don't throw
 *   - The bash-redirection heuristic respects quoting and skips 2>&1
 *
 * Version-pin note: when pi upstream adds a new write-class tool, update
 * WRITE_CLASS_TOOLS and add a matching case here. The companion version-
 * check test (session-touched-files.version-check.test.ts) asserts pi's
 * internal extractFileOpsFromMessage still exists at the expected path.
 */

import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  extractBashRedirectionTargets,
  extractFileOpsFromMessage,
  getSessionTouchedFiles,
  WRITE_CLASS_TOOLS,
} from "./session-touched-files";

/**
 * Minimal assistant-message builder. We intentionally don't pull in the
 * pi-ai `AssistantMessage` type here \u2014 the structural interface in
 * session-touched-files.ts (role + content) is what actually gets exercised
 * in production (entries come from the session file as JSON).
 */
// biome-ignore lint/suspicious/noExplicitAny: test fixture factory
function mkAssistant(content: any[]): any {
  return { role: "assistant", content };
}

describe("WRITE_CLASS_TOOLS", () => {
  test("includes write and edit", () => {
    expect(WRITE_CLASS_TOOLS.has("write")).toBe(true);
    expect(WRITE_CLASS_TOOLS.has("edit")).toBe(true);
  });

  test("does NOT include read (read-only ops are out of scope for overlap detection)", () => {
    expect(WRITE_CLASS_TOOLS.has("read")).toBe(false);
  });
});

describe("extractFileOpsFromMessage", () => {
  test("empty content array: []", () => {
    expect(extractFileOpsFromMessage(mkAssistant([]))).toEqual([]);
  });

  test("write tool: extracts path", () => {
    const msg = mkAssistant([
      {
        type: "toolCall",
        id: "tc1",
        name: "write",
        arguments: { path: "/vault/note.md", content: "x" },
      },
    ]);
    expect(extractFileOpsFromMessage(msg)).toEqual(["/vault/note.md"]);
  });

  test("edit tool: extracts path", () => {
    const msg = mkAssistant([
      {
        type: "toolCall",
        id: "tc1",
        name: "edit",
        arguments: { path: "/vault/a.md", oldText: "a", newText: "b" },
      },
    ]);
    expect(extractFileOpsFromMessage(msg)).toEqual(["/vault/a.md"]);
  });

  test("read tool (not a write): ignored", () => {
    const msg = mkAssistant([
      {
        type: "toolCall",
        id: "tc1",
        name: "read",
        arguments: { path: "/vault/a.md" },
      },
    ]);
    expect(extractFileOpsFromMessage(msg)).toEqual([]);
  });

  test("multiple tool calls in one message: paths accumulated in order", () => {
    const msg = mkAssistant([
      {
        type: "toolCall",
        id: "tc1",
        name: "write",
        arguments: { path: "first.md", content: "x" },
      },
      {
        type: "toolCall",
        id: "tc2",
        name: "edit",
        arguments: { path: "second.md", oldText: "a", newText: "b" },
      },
    ]);
    expect(extractFileOpsFromMessage(msg)).toEqual(["first.md", "second.md"]);
  });

  test("duplicate tool calls in one message: NOT deduped here (caller handles via Set)", () => {
    const msg = mkAssistant([
      {
        type: "toolCall",
        id: "tc1",
        name: "write",
        arguments: { path: "same.md", content: "a" },
      },
      {
        type: "toolCall",
        id: "tc2",
        name: "write",
        arguments: { path: "same.md", content: "b" },
      },
    ]);
    expect(extractFileOpsFromMessage(msg)).toEqual(["same.md", "same.md"]);
  });

  test("malformed: missing arguments -> ignored", () => {
    const msg = mkAssistant([{ type: "toolCall", id: "tc1", name: "write" }]);
    expect(extractFileOpsFromMessage(msg)).toEqual([]);
  });

  test("malformed: arguments.path is not a string -> ignored", () => {
    const msg = mkAssistant([
      {
        type: "toolCall",
        id: "tc1",
        name: "write",
        arguments: { path: 42, content: "x" },
      },
    ]);
    expect(extractFileOpsFromMessage(msg)).toEqual([]);
  });

  test("text block (not a tool call): ignored", () => {
    const msg = mkAssistant([
      { type: "text", text: "I am going to write a file" },
    ]);
    expect(extractFileOpsFromMessage(msg)).toEqual([]);
  });

  test("non-assistant message: empty result", () => {
    expect(extractFileOpsFromMessage({ role: "user", content: [] })).toEqual(
      [],
    );
  });

  test("bash with redirect: path captured", () => {
    const msg = mkAssistant([
      {
        type: "toolCall",
        id: "tc1",
        name: "bash",
        arguments: { command: "echo hi > /tmp/out.md" },
      },
    ]);
    expect(extractFileOpsFromMessage(msg)).toEqual(["/tmp/out.md"]);
  });

  test("bash without write: ignored", () => {
    const msg = mkAssistant([
      {
        type: "toolCall",
        id: "tc1",
        name: "bash",
        arguments: { command: "ls -la" },
      },
    ]);
    expect(extractFileOpsFromMessage(msg)).toEqual([]);
  });

  test("bash with non-string command: ignored", () => {
    const msg = mkAssistant([
      {
        type: "toolCall",
        id: "tc1",
        name: "bash",
        arguments: { command: 42 },
      },
    ]);
    expect(extractFileOpsFromMessage(msg)).toEqual([]);
  });
});

describe("extractBashRedirectionTargets", () => {
  test("simple > redirect", () => {
    expect(extractBashRedirectionTargets("echo hi > foo.md")).toEqual([
      "foo.md",
    ]);
  });

  test(">> append redirect", () => {
    expect(extractBashRedirectionTargets("cat a >> log.txt")).toEqual([
      "log.txt",
    ]);
  });

  test("2>&1 is NOT captured (stderr fd dup, not a file write)", () => {
    expect(extractBashRedirectionTargets("make 2>&1")).toEqual([]);
  });

  test("2>&1 combined with tee still captures tee target", () => {
    expect(
      extractBashRedirectionTargets("make 2>&1 | tee /tmp/build.log"),
    ).toEqual(["/tmp/build.log"]);
  });

  test("quoted target", () => {
    expect(
      extractBashRedirectionTargets('echo x > "path with spaces.md"'),
    ).toEqual(["path with spaces.md"]);
  });

  test("single-quoted target", () => {
    expect(extractBashRedirectionTargets("echo x > 'a b.md'")).toEqual([
      "a b.md",
    ]);
  });

  test("tee with -a flag still captures target", () => {
    expect(extractBashRedirectionTargets("echo x | tee -a /tmp/log")).toEqual([
      "/tmp/log",
    ]);
  });

  test("no redirection: empty array", () => {
    expect(extractBashRedirectionTargets("ls -la")).toEqual([]);
  });

  test("multiple redirects in one command: both captured", () => {
    expect(
      extractBashRedirectionTargets("echo a > one.md; echo b >> two.md"),
    ).toEqual(["one.md", "two.md"]);
  });
});

describe("getSessionTouchedFiles", () => {
  function mkEntry(msg: unknown): SessionEntry {
    return {
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: new Date().toISOString(),
      // biome-ignore lint/suspicious/noExplicitAny: structural session entry
      message: msg as any,
      // biome-ignore lint/suspicious/noExplicitAny: structural session entry
    } as any;
  }

  test("empty session: empty set", () => {
    const got = getSessionTouchedFiles({ getEntries: () => [] });
    expect(got.size).toBe(0);
  });

  test("session with one write: set has one path", () => {
    const entries: SessionEntry[] = [
      mkEntry(
        mkAssistant([
          {
            type: "toolCall",
            id: "tc1",
            name: "write",
            arguments: { path: "a.md", content: "x" },
          },
        ]),
      ),
    ];
    const got = getSessionTouchedFiles({ getEntries: () => entries });
    expect(got).toEqual(new Set(["a.md"]));
  });

  test("duplicate writes across messages: deduped by Set", () => {
    const entries: SessionEntry[] = [
      mkEntry(
        mkAssistant([
          {
            type: "toolCall",
            id: "tc1",
            name: "write",
            arguments: { path: "same.md", content: "x" },
          },
        ]),
      ),
      mkEntry(
        mkAssistant([
          {
            type: "toolCall",
            id: "tc2",
            name: "edit",
            arguments: { path: "same.md", oldText: "a", newText: "b" },
          },
        ]),
      ),
    ];
    const got = getSessionTouchedFiles({ getEntries: () => entries });
    expect(got).toEqual(new Set(["same.md"]));
  });

  test("skips non-message and non-assistant entries", () => {
    const entries: SessionEntry[] = [
      {
        type: "custom",
        id: "c1",
        parentId: null,
        timestamp: "",
        customType: "t",
        data: {},
      },
      mkEntry({ role: "user", content: "hi" }),
      mkEntry(
        mkAssistant([
          {
            type: "toolCall",
            id: "tc1",
            name: "write",
            arguments: { path: "a.md", content: "x" },
          },
        ]),
      ),
    ];
    const got = getSessionTouchedFiles({ getEntries: () => entries });
    expect(got).toEqual(new Set(["a.md"]));
  });
});
