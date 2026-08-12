// SPDX-License-Identifier: MIT
// Part of pi-napkin.

import { existsSync, statSync } from "node:fs";
import * as path from "node:path";
import type { PredicateContext } from "@cad0p/pi-steering";

/**
 * Directory marker that identifies a napkin vault (napkin's
 * `findAncestorVault` / `findVault` walk looks for the same name).
 */
export const NAPKIN_MARKER = ".napkin";

/**
 * Walk up from `startDir` looking for an existing vault's `.napkin/`
 * (or `.obsidian/.napkin/` for the nested layout) at any level.
 * Read-only structural mirror of napkin's `findAncestorVault`
 * (`@cad0p/napkin/src/utils/vault.ts`) — deliberately NOT imported
 * from `@cad0p/napkin`:
 *
 *   - napkin's exports map is `"." → ./src/index.ts` only, so a deep
 *     import is blocked, and `findAncestorVault` isn't re-exported
 *     from the root.
 *   - a steering predicate must NEVER touch the filesystem beyond
 *     read probes: no `createBareVault` fallback and no global-vault
 *     fallback (`$XDG_CONFIG_HOME/napkin/config.json`). A global
 *     fallback would make every cwd a "vault" and exempt the
 *     no-main-commit guards everywhere.
 *
 * Returns the directory that contains the marker, or null.
 */
export function isNapkinVaultDir(startDir?: string): string | null {
  let dir = path.resolve(startDir || process.cwd());
  const root = path.parse(dir).root;

  while (true) {
    const napkinDir = path.join(dir, NAPKIN_MARKER);
    if (existsSync(napkinDir) && statSync(napkinDir).isDirectory()) {
      return dir;
    }

    const nestedNapkin = path.join(dir, ".obsidian", NAPKIN_MARKER);
    if (existsSync(nestedNapkin) && statSync(nestedNapkin).isDirectory()) {
      return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir || dir === root) {
      return null;
    }
    dir = parent;
  }
}

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
