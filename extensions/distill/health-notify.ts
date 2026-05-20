/**
 * Surface findings from {@link ensureVaultReadyForDistill} as user-facing
 * notifications. Auto-recovered findings are grouped into a single info
 * notify (one per call); error findings are grouped into a single error
 * notify. Returns whether any error finding fired so the caller can
 * decide to abort a worktree-based spawn.
 *
 * The helper is `hasUI`-safe: when `ctx.hasUI === false` (subprocess,
 * detached test contexts), no notifications are emitted but the return
 * value still reflects the error-finding signal so the caller's abort
 * logic continues to work.
 */

import type { HealthFinding } from "./auto-setup";

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
  const recovered = findings.filter((f) => f.kind === "auto-recovered");
  const errors = findings.filter((f) => f.kind === "error");

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
