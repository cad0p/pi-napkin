/**
 * Unit tests for the `/distill-status` and `napkin_distill_status` surfaces.
 *
 * Both surfaces share the same underlying data (worktree enumeration via
 * `getActiveDistills` + orphan-branch enumeration via
 * `getUnmergedDistillBranches`), but differ in presentation. The
 * presentation layer is extracted into pure formatters exported from
 * `./index.ts` so these tests can run without mocking the full pi
 * `ExtensionAPI`.
 *
 * The input side (`collectDistillStatus`) is covered indirectly via the
 * integration-style tests in `distill-workspace.test.ts` for the helpers
 * it delegates to. Here we focus on:
 *   - formatter output shape for 0 / 1 / N active distills
 *   - formatter handling of unmerged branches (including the no-active +
 *     unmerged case)
 *   - JSON tool output shape for the agent
 */

import { describe, expect, test } from "bun:test";
import type { ActiveDistill } from "./distill-workspace";
import { distillStatusToJson, formatDistillStatus } from "./index";

function makeActive(overrides: Partial<ActiveDistill>): ActiveDistill {
  return {
    pid: 1234,
    branch: "distill/abc123-1715198400",
    worktreePath:
      "/home/user/.cache/napkin-distill/abc1234567890def/abc123-1715198400",
    startedAt: new Date(1715198400 * 1000).toISOString(),
    elapsedMs: 84_000,
    sessionPath: "/tmp/sessions/parent-session.jsonl",
    alive: true,
    startSha: "abc1234567",
    ...overrides,
  };
}

describe("formatDistillStatus", () => {
  test('no active distills + no unmerged branches: single-line "No active distills."', () => {
    expect(formatDistillStatus([], [])).toBe("No active distills.");
  });

  test("one active distill: header + indented line with pid/elapsed/branch/session", () => {
    const out = formatDistillStatus([makeActive({})], []);
    expect(out).toBe(
      [
        "Active distills (1):",
        "  [1234] 84s  branch=distill/abc123-1715198400  session=parent-session.jsonl",
      ].join("\n"),
    );
  });

  test("three active distills: one header + three lines, each with its own pid/branch", () => {
    const out = formatDistillStatus(
      [
        makeActive({
          pid: 48312,
          branch: "distill/abc-1715198400",
          elapsedMs: 84_000,
          sessionPath: "/sessions/a.jsonl",
        }),
        makeActive({
          pid: 48510,
          branch: "distill/def-1715198441",
          elapsedMs: 45_000,
          sessionPath: "/sessions/b.jsonl",
        }),
        makeActive({
          pid: 48811,
          branch: "distill/ghi-1715198474",
          elapsedMs: 12_000,
          sessionPath: "/sessions/c.jsonl",
        }),
      ],
      [],
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("Active distills (3):");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("[48312] 84s");
    expect(lines[2]).toContain("[48510] 45s");
    expect(lines[3]).toContain("[48811] 12s");
  });

  test("dead-pid distill is annotated with ' (dead)' marker", () => {
    const out = formatDistillStatus(
      [makeActive({ alive: false, pid: 99999 })],
      [],
    );
    expect(out).toContain("[99999] 84s");
    expect(out).toContain(" (dead)");
  });

  test("unknown sessionPath renders as session=unknown", () => {
    const out = formatDistillStatus([makeActive({ sessionPath: null })], []);
    expect(out).toContain("session=unknown");
  });

  test("zero active + unmerged branches: unmerged block still renders", () => {
    const out = formatDistillStatus([], ["distill/xyz-456", "distill/old-789"]);
    expect(out).toBe(
      [
        "No active distills.",
        "Unmerged branches (2):",
        "  distill/xyz-456  (no active process)",
        "  distill/old-789  (no active process)",
      ].join("\n"),
    );
  });

  test("active + unmerged: both blocks render, active first", () => {
    const out = formatDistillStatus(
      [makeActive({ branch: "distill/live-1" })],
      ["distill/orphan-2"],
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("Active distills (1):");
    expect(lines[1]).toContain("distill/live-1");
    expect(lines[2]).toBe("Unmerged branches (1):");
    expect(lines[3]).toBe("  distill/orphan-2  (no active process)");
  });

  test("elapsed seconds rounds down, zero when elapsedMs < 1000", () => {
    expect(formatDistillStatus([makeActive({ elapsedMs: 42 })], [])).toContain(
      " 0s",
    );
    expect(
      formatDistillStatus([makeActive({ elapsedMs: 1999 })], []),
    ).toContain(" 1s");
  });
});

describe("distillStatusToJson", () => {
  test("empty state serialises to empty arrays", () => {
    const json = distillStatusToJson([], []);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual({ active: [], unmerged: [] });
  });

  test("one active distill: JSON shape matches spec's return shape", () => {
    const json = distillStatusToJson(
      [
        makeActive({
          pid: 48312,
          branch: "distill/abc-123",
          elapsedMs: 84_000,
          sessionPath: "/tmp/sessions/main.jsonl",
        }),
      ],
      [],
    );
    const parsed = JSON.parse(json);
    // Spec-mandated shape: { active: [{ pid, branch, elapsedSeconds, session }], unmerged: [] }
    expect(parsed.active).toHaveLength(1);
    expect(parsed.active[0]).toMatchObject({
      pid: 48312,
      branch: "distill/abc-123",
      elapsedSeconds: 84,
      session: "main.jsonl",
    });
    expect(parsed.unmerged).toEqual([]);
  });

  test("active with unknown session serialises as session=null", () => {
    const json = distillStatusToJson([makeActive({ sessionPath: null })], []);
    const parsed = JSON.parse(json);
    expect(parsed.active[0].session).toBeNull();
  });

  test("unmerged branches pass through as-is", () => {
    const json = distillStatusToJson(
      [],
      ["distill/xyz-456", "distill/old-789"],
    );
    const parsed = JSON.parse(json);
    expect(parsed.unmerged).toEqual(["distill/xyz-456", "distill/old-789"]);
  });

  test("dead pid is reflected via alive=false so the agent can distinguish states", () => {
    const json = distillStatusToJson(
      [makeActive({ pid: 99999, alive: false })],
      [],
    );
    const parsed = JSON.parse(json);
    expect(parsed.active[0].alive).toBe(false);
  });

  test("JSON output is valid UTF-8 and reparseable", () => {
    const json = distillStatusToJson([makeActive({})], ["distill/x"]);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
