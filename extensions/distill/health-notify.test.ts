import { describe, expect, test } from "bun:test";

import type { HealthFinding } from "./auto-setup";
import { surfaceHealthFindings, surfaceSetupError } from "./health-notify";

/**
 * Direct unit tests for `surfaceHealthFindings` and `surfaceSetupError`.
 * The wiring tests in `health-check-wiring.test.ts` exercise the
 * helpers indirectly via real extension call sites; this file pins
 * each helper's contract on the branches that the wiring tests do not
 * cover (multi-finding render, `hasUI: false` subprocess path,
 * return-shape, exact-format canonical message) so a future refactor
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
        // Use a production-emitted error invariant ID so a reader
        // tracing the fixture back to its source finds the real
        // emitter. Renderer is invariant-name-agnostic; only the
        // `kind: "error"` + `message` shape is exercised here.
        invariant: "napkin-distill-not-tracked",
        message:
          "/path/.napkin/distill/ contains tracked files [a.md]; auto-untrack would risk data loss.",
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
      "Auto-distill cannot proceed: /path/.napkin/distill/ contains tracked files [a.md]; auto-untrack would risk data loss.",
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
        // Production-emitted error invariant; the renderer iterates
        // a heterogeneous error list, so the second fixture uses a
        // distinct invariant ID from the first to mirror real
        // multi-finding output.
        invariant: "napkin-distill-not-tracked",
        message: "/path/.napkin/distill/ contains tracked files.",
      },
    ];
    const result = surfaceHealthFindings(ctx, findings);
    expect(notifies).toHaveLength(1);
    expect(notifies[0].severity).toBe("error");
    expect(notifies[0].msg).toBe(
      "Auto-distill cannot proceed:\n" +
        "- marker drift on /path/.gitignore.\n" +
        "- /path/.napkin/distill/ contains tracked files.",
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

describe("surfaceSetupError", () => {
  test("undefined setupError: no notify", () => {
    // The healthy-vault path: `ensureVaultReadyForDistill` returns
    // `setup.error === undefined` whenever the IO layer succeeds. Pin
    // that the helper is a no-op in this case so a future refactor
    // that hoists the notify out of the truthiness guard (e.g.
    // mutating `if (setupError && ctx.hasUI)` to `if (ctx.hasUI)`)
    // would surface here as `Auto-distill setup failed: undefined.`
    // instead of slipping through the wiring tests (which only
    // exercise the populated-error path).
    const { ctx, notifies } = makeCtx(true);
    surfaceSetupError(ctx, undefined);
    expect(notifies).toEqual([]);
  });

  test("populated setupError + hasUI=true: one error notify with canonical format", () => {
    // Pin the exact user-facing message format. The trailing period is
    // load-bearing (callers grep on the `Auto-distill setup failed: `
    // prefix in logs; the period closes the sentence so a follow-up
    // sentence at the session_start call site reads naturally), and
    // the severity is `error` (not `warning`) so the UI surfaces it
    // prominently.
    const { ctx, notifies } = makeCtx(true);
    surfaceSetupError(ctx, "git init failed: ENOENT");
    expect(notifies).toHaveLength(1);
    expect(notifies[0].severity).toBe("error");
    expect(notifies[0].msg).toBe(
      "Auto-distill setup failed: git init failed: ENOENT.",
    );
  });

  test("populated setupError + hasUI=false: no notify (subprocess path)", () => {
    // Subprocess and detached test contexts: the helper must not call
    // ctx.ui.notify (the surface may be a no-op stub or absent).
    // `surfaceSetupError` returns void, so unlike `surfaceHealthFindings`
    // there is no signal-channel for the caller to act on — callers
    // in subprocess paths simply abort the spawn via other means.
    const { ctx, notifies } = makeCtx(false);
    surfaceSetupError(ctx, "failed to write scaffolding");
    expect(notifies).toEqual([]);
  });
});
