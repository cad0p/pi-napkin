/**
 * Two helpers that surface the dual-channel output of
 * {@link ensureVaultReadyForDistill} as user-facing notifications:
 *
 * - {@link surfaceHealthFindings} renders the structured `findings`
 *   channel. Auto-recovered findings collapse into one info notify;
 *   error findings collapse into one error notify. Returns
 *   `{ hasErrors }` so callers can abort a worktree-based spawn.
 * - {@link surfaceSetupError} renders the free-form `setup.error`
 *   channel for fail-soft IO failures (`git init` / `git add` /
 *   `git commit` / scaffolding-write) that have no corresponding
 *   structured finding. Single error notify; void return.
 *
 * Both helpers are `hasUI`-safe: when `ctx.hasUI === false`
 * (subprocess, detached test contexts), no notifications are emitted.
 * `surfaceHealthFindings` still returns the error-finding signal so
 * the caller's abort logic continues to work in the non-UI path.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ensureVaultReadyForDistill, HealthFinding } from "./auto-setup";

/**
 * Subset of `ExtensionContext` the helper needs: a `hasUI` flag plus a
 * minimal `ui.notify` surface. Kept narrow so test stubs don't have to
 * implement the full pi UI contract. Internal to this module — no
 * out-of-file consumer; tests use structural typing on the helper's
 * parameter rather than importing the interface.
 */
interface HealthNotifyCtx {
  hasUI: boolean;
  ui: {
    notify: (message: string, severity: "info" | "warning" | "error") => void;
  };
}

/** Wrapper-emitted durable failure ledger, stored in the distill error dir. */
export const DISTILL_FAILURE_LEDGER_FILE = "failures.log";
const DISTILL_FAILURE_LEDGER_CURSOR_FILE = "failures.log.seen";

function failureLedgerPaths(errorDir: string): {
  ledger: string;
  cursor: string;
} {
  return {
    ledger: path.join(errorDir, DISTILL_FAILURE_LEDGER_FILE),
    cursor: path.join(errorDir, DISTILL_FAILURE_LEDGER_CURSOR_FILE),
  };
}

function readLedgerCursor(cursorPath: string): number {
  try {
    const raw = fs.readFileSync(cursorPath, "utf-8").trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeLedgerCursor(cursorPath: string, offset: number): void {
  try {
    fs.writeFileSync(cursorPath, String(offset));
  } catch {
    // Advisory-only: failing to persist the cursor must never block distill.
  }
}

/**
 * Mark every currently present wrapper failure-ledger byte as seen. Called
 * when the active session has already rendered the failed:* outcome through
 * the normal outcome-sidecar dispatch, preventing a duplicate session-start
 * notification later. Best-effort and silent by design.
 */
export function markDistillFailureLedgerSeen(errorDir: string): void {
  const { ledger, cursor } = failureLedgerPaths(errorDir);
  try {
    const size = fs.statSync(ledger).size;
    writeLedgerCursor(cursor, size);
  } catch {
    // No ledger (or unreadable ledger): nothing to mark.
  }
}

/**
 * Surface wrapper failures that completed after their parent session went
 * away. The wrapper appends one line per failed:* outcome to failures.log;
 * this helper renders only bytes after the shared cursor through the same
 * ctx.ui.notify path used for health findings, then advances the cursor.
 *
 * The cursor is deliberately shared rather than per-session: the contract is
 * that a session sees the failure once, not that every session is spammed.
 * If no UI exists, nothing is marked seen so a later interactive session can
 * still surface the line.
 */
export function surfaceDistillFailureLedger(
  ctx: HealthNotifyCtx,
  errorDir: string,
): { surfaced: number } {
  if (!ctx.hasUI) return { surfaced: 0 };
  const { ledger, cursor } = failureLedgerPaths(errorDir);
  try {
    if (!fs.existsSync(ledger)) return { surfaced: 0 };
    const buf = fs.readFileSync(ledger);
    let offset = readLedgerCursor(cursor);
    if (offset > buf.length) offset = 0;
    const lines = buf
      .subarray(offset)
      .toString("utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length > 0) {
      ctx.ui.notify(
        lines.length === 1
          ? "Auto-distill failure recorded: " + lines[0]
          : "Auto-distill failures recorded:\n" +
              lines.map((line) => "- " + line).join("\n"),
        "error",
      );
    }
    writeLedgerCursor(cursor, buf.length);
    return { surfaced: lines.length };
  } catch {
    return { surfaced: 0 };
  }
}

/**
 * Render `findings` to the user via `ctx.ui.notify`. Auto-recovered
 * findings collapse into a single info notify; error findings collapse
 * into a single error notify. Returns `{ hasErrors }` so the caller can
 * skip the worktree-based spawn when the vault is not in a usable state.
 *
 * Empty `findings` is the healthy-vault path: no notifications, no
 * errors. The caller proceeds normally.
 */
export function surfaceHealthFindings(
  ctx: HealthNotifyCtx,
  findings: readonly HealthFinding[],
): { hasErrors: boolean } {
  const recovered: HealthFinding[] = [];
  const errors: HealthFinding[] = [];
  for (const finding of findings) {
    switch (finding.kind) {
      case "auto-recovered":
        recovered.push(finding);
        break;
      case "error":
        errors.push(finding);
        break;
      default: {
        // A future third `HealthFinding.kind` would silently produce
        // no notify under the previous filter-based shape. The
        // exhaustiveness assertion forces a tsc error at the
        // partitioning site so a maintainer adding a new variant
        // updates the renderer at the same time. Mirrors the
        // `_exhaustive: never` pattern used by the verify-e2e variant
        // switches.
        const _exhaustive: never = finding.kind;
        throw new Error(
          `surfaceHealthFindings: unhandled HealthFinding.kind ${String(_exhaustive)}`,
        );
      }
    }
  }

  if (ctx.hasUI && recovered.length > 0) {
    const lines = recovered.map((f) =>
      f.recovery ? `${f.message} (${f.recovery})` : f.message,
    );
    ctx.ui.notify(
      lines.length === 1
        ? `Auto-distill recovered: ${lines[0]}`
        : `Auto-distill recovered:\n${lines.map((l) => `- ${l}`).join("\n")}`,
      "info",
    );
  }

  if (ctx.hasUI && errors.length > 0) {
    const lines = errors.map((f) => f.message);
    ctx.ui.notify(
      lines.length === 1
        ? `Auto-distill cannot proceed: ${lines[0]}`
        : `Auto-distill cannot proceed:\n${lines.map((l) => `- ${l}`).join("\n")}`,
      "error",
    );
  }

  return { hasErrors: errors.length > 0 };
}

/**
 * Render the fail-soft `setup.error` channel from
 * {@link ensureVaultReadyForDistill} as a single user-facing error
 * notify. `setup.error` is populated for generic IO failures (`git
 * init` / `git add` / `git commit` / scaffolding-write) that have no
 * corresponding structured finding; the structured `findings` channel
 * is rendered separately by {@link surfaceHealthFindings}.
 *
 * Canonical message format: `Auto-distill setup failed: <error>.`
 * (note the trailing period — callers depend on this for grep-friendly
 * log scraping). When `setupError` is `undefined` the helper is a
 * no-op. `hasUI`-safe: subprocess and detached test contexts skip the
 * notify entirely.
 */
export function surfaceSetupError(
  ctx: HealthNotifyCtx,
  setupError: string | undefined,
): void {
  if (setupError && ctx.hasUI) {
    ctx.ui.notify(`Auto-distill setup failed: ${setupError}.`, "error");
  }
}
