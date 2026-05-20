import { describe, expect, test } from "bun:test";

import type { HealthFinding } from "./auto-setup";
import { surfaceHealthFindings } from "./health-notify";

/**
 * Direct unit tests for `surfaceHealthFindings`. The wiring tests in
 * `health-check-wiring.test.ts` exercise the helper indirectly via real
 * extension call sites; this file pins the helper's contract on the
 * branches that the wiring tests do not cover (multi-finding render,
 * `hasUI: false` subprocess path, return-shape) so a future refactor
 * that drops one of those branches surfaces immediately.
 */

interface Notify {
  msg: string;
  severity: "info" | "warning" | "error";
}

/**
 * Build a minimal context plus a captured-notifies array. The shape
 * matches the helper's expected `ctx` parameter via structural typing —
 * intentionally not importing the helper's interface so the helper's
 * type definition remains internal-only at the source level.
 */
function makeCtx(hasUI: boolean): {
  ctx: {
    hasUI: boolean;
    ui: { notify: (m: string, s: Notify["severity"]) => void };
  };
  notifies: Notify[];
} {
  const notifies: Notify[] = [];
  const ctx = {
    hasUI,
    ui: {
      notify: (msg: string, severity: Notify["severity"]) => {
        notifies.push({ msg, severity });
      },
    },
  };
  return { ctx, notifies };
}

describe("surfaceHealthFindings", () => {
  test("empty findings: no notify, hasErrors=false", () => {
    const { ctx, notifies } = makeCtx(true);
    const result = surfaceHealthFindings(ctx, []);
    expect(notifies).toEqual([]);
    expect(result).toEqual({ hasErrors: false });
  });

  test("single auto-recovered finding: one info notify with prefix and recovery label", () => {
    const { ctx, notifies } = makeCtx(true);
    const findings: HealthFinding[] = [
      {
        kind: "auto-recovered",
        invariant: "gitignore-block-correct",
        message: "/path/.gitignore did not contain a managed block; installed.",
        recovery: "installed",
      },
    ];
    const result = surfaceHealthFindings(ctx, findings);
    expect(notifies).toHaveLength(1);
    expect(notifies[0].severity).toBe("info");
    expect(notifies[0].msg).toBe(
      "Auto-distill recovered: /path/.gitignore did not contain a managed block; installed. (installed)",
    );
    expect(result).toEqual({ hasErrors: false });
  });

  test("single error finding: one error notify with prefix, hasErrors=true", () => {
    const { ctx, notifies } = makeCtx(true);
    const findings: HealthFinding[] = [
      {
        kind: "error",
        invariant: "gitignore-block-correct",
        message: "/path/.gitignore contains malformed managed-block markers.",
      },
    ];
    const result = surfaceHealthFindings(ctx, findings);
    expect(notifies).toHaveLength(1);
    expect(notifies[0].severity).toBe("error");
    expect(notifies[0].msg).toBe(
      "Auto-distill cannot proceed: /path/.gitignore contains malformed managed-block markers.",
    );
    expect(result).toEqual({ hasErrors: true });
  });

  test("mixed findings: one info + one error notify, hasErrors=true", () => {
    const { ctx, notifies } = makeCtx(true);
    const findings: HealthFinding[] = [
      {
        kind: "auto-recovered",
        invariant: "vault-is-git-repo",
        message: "Initialized git repo at /path.",
        recovery: "ran git init",
      },
      {
        kind: "auto-recovered",
        invariant: "gitignore-block-correct",
        message: "/path/.gitignore did not contain a managed block; installed.",
        recovery: "installed",
      },
      {
        kind: "error",
        invariant: "config.json-valid-json",
        message:
          "/path/.napkin/config.json is not valid JSON: Unexpected token.",
      },
    ];
    const result = surfaceHealthFindings(ctx, findings);
    // Exactly two notifies: one combined info, one error.
    expect(notifies).toHaveLength(2);
    const infos = notifies.filter((n) => n.severity === "info");
    const errors = notifies.filter((n) => n.severity === "error");
    expect(infos).toHaveLength(1);
    expect(errors).toHaveLength(1);
    // Multi-finding info renders as bulleted list (each line has the
    // recovery label appended).
    expect(infos[0].msg).toBe(
      "Auto-distill recovered:\n" +
        "- Initialized git repo at /path. (ran git init)\n" +
        "- /path/.gitignore did not contain a managed block; installed. (installed)",
    );
    expect(errors[0].msg).toBe(
      "Auto-distill cannot proceed: /path/.napkin/config.json is not valid JSON: Unexpected token.",
    );
    expect(result).toEqual({ hasErrors: true });
  });

  test("multiple error findings render as a bulleted list under one notify", () => {
    const { ctx, notifies } = makeCtx(true);
    const findings: HealthFinding[] = [
      {
        kind: "error",
        invariant: "gitignore-block-correct",
        message: "marker drift on /path/.gitignore.",
      },
      {
        kind: "error",
        invariant: "config.json-valid-json",
        message: "parse error on /path/.napkin/config.json.",
      },
    ];
    const result = surfaceHealthFindings(ctx, findings);
    expect(notifies).toHaveLength(1);
    expect(notifies[0].severity).toBe("error");
    expect(notifies[0].msg).toBe(
      "Auto-distill cannot proceed:\n" +
        "- marker drift on /path/.gitignore.\n" +
        "- parse error on /path/.napkin/config.json.",
    );
    expect(result).toEqual({ hasErrors: true });
  });

  test("hasUI=false: no notify but hasErrors still reflects findings", () => {
    // Subprocess / detached test contexts: the helper must not call
    // ctx.ui.notify (the surface may be a no-op stub or absent), but
    // hasErrors must still be computed so the caller's abort logic
    // works in the non-UI path. Pin both branches here.
    const { ctx: errCtx, notifies: errNotifies } = makeCtx(false);
    const errResult = surfaceHealthFindings(errCtx, [
      {
        kind: "error",
        invariant: "gitignore-block-correct",
        message: "marker drift.",
      },
    ]);
    expect(errNotifies).toEqual([]);
    expect(errResult).toEqual({ hasErrors: true });

    const { ctx: okCtx, notifies: okNotifies } = makeCtx(false);
    const okResult = surfaceHealthFindings(okCtx, [
      {
        kind: "auto-recovered",
        invariant: "gitignore-block-correct",
        message: "installed.",
        recovery: "installed",
      },
    ]);
    expect(okNotifies).toEqual([]);
    expect(okResult).toEqual({ hasErrors: false });
  });

  test("hasErrors return shape is exactly { hasErrors: boolean } — no extra fields", () => {
    // Pin the return shape so a future refactor that returns the
    // error-finding count or array doesn't slip through type-narrowing.
    // Object.keys + toBe(true)/toBe(false) is stricter than `typeof ===
    // "boolean"` (which would also accept a wrapped Boolean object) and
    // tighter than the rest of the file's existing per-finding shape
    // assertions, since it pins the absence of additional fields.
    const { ctx: emptyCtx } = makeCtx(true);
    const empty = surfaceHealthFindings(emptyCtx, []);
    expect(Object.keys(empty)).toEqual(["hasErrors"]);
    expect(empty.hasErrors).toBe(false);

    const { ctx: errCtx } = makeCtx(true);
    const err = surfaceHealthFindings(errCtx, [
      {
        kind: "error",
        invariant: "subdir-layout",
        message: "err",
      },
    ]);
    expect(Object.keys(err)).toEqual(["hasErrors"]);
    expect(err.hasErrors).toBe(true);
  });
});
