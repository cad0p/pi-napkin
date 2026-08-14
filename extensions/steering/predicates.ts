// SPDX-License-Identifier: MIT
// Part of pi-napkin.

import { findAncestorVault } from "@cad0p/napkin";
import type { PredicateContext } from "@cad0p/pi-steering";

/**
 * Back-compat alias for napkin's canonical vault walk.
 *
 * The canonical implementation lives in napkin (`findAncestorVault`):
 * a purely structural walk-up looking for the `.napkin/` marker (or
 * `.obsidian/.napkin/` for the nested layout) at any level — no
 * global-config fallback, no writes. Identical semantics to the
 * mirror this package previously shipped, so the steering plugin's
 * fail-closed posture is unchanged (a read-only probe that can
 * never make an arbitrary cwd look like a vault). The alias
 * preserves the public export name the global steering config
 * imports (`isNapkinVaultDir` from `@cad0p/pi-napkin/steering`).
 */
export const isNapkinVaultDir = findAncestorVault;

/**
 * `isNapkinVault` predicate handler — registered by the napkin
 * steering plugin under the `when.isNapkinVault` slot
 * (`PredicateShape<boolean>` bare form).
 *
 * Fail-closed contract:
 *
 *   - `args !== true` → `false` (only the bare `true` form asks for
 *     the check; the spread `{ value: ... }` form is not meaningful
 *     for this boolean probe).
 *   - `ctx.cwd === "unknown"` (walker couldn't statically resolve
 *     the effective cwd) → returns the `"unknown"` sentinel, NOT
 *     `false`. Unknown cwd is not the same as "not a vault", and the
 *     trinary composes with the rule's own `onUnknown:` policy when
 *     the predicate is used as a public `when` leaf. Inside an
 *     exemption clause both verdicts behave identically — exemption
 *     clauses are STRICTLY fail-closed (anything non-true = no
 *     exemption = the guard still fires), so this can never weaken
 *     `no-main-commit` / `no-main-commit-github`.
 *   - Known cwd → read-only walk-up for the `.napkin/` marker
 *     (see {@link isNapkinVaultDir}). No writes, no global-config
 *     fallback.
 */
export function isNapkinVault(
  args: unknown,
  ctx: PredicateContext,
): boolean | "unknown" {
  if (args !== true) return false;
  if (ctx.cwd === "unknown") return "unknown";
  return isNapkinVaultDir(ctx.cwd) !== null;
}
