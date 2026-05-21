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
