// SPDX-License-Identifier: MIT
// Part of pi-napkin.

import type { Plugin, PredicateShape } from "@cad0p/pi-steering";
import { isNapkinVault, isNapkinVaultDir } from "./predicates.ts";

declare global {
  /**
   * `when.isNapkinVault` — true when the effective cwd is inside a
   * napkin vault (read-only `.napkin/`-marker walk-up). Registered
   * by the napkin steering plugin; usable by any config that lists
   * the plugin. Fail-closed: unknown cwd → `"unknown"` sentinel.
   */
  interface PiSteeringPredicates {
    isNapkinVault: PredicateShape<boolean>;
  }
}

/**
 * The napkin steering plugin for `@cad0p/pi-steering`.
 *
 * Subpath import: `@cad0p/pi-napkin/steering`.
 *
 * Registers (in the terms of `Plugin`):
 *
 *   - `predicates`     - `isNapkinVault` (see `./predicates.ts` for
 *                         the fail-closed contract).
 *   - `exemptions`     - carve-outs of the shipped git-plugin rules
 *                         `no-main-commit` / `no-main-commit-github`
 *                         when `when.isNapkinVault` matches. The
 *                         napkin workflow legitimately commits +
 *                         pushes to `main` inside vaults (note edits,
 *                         the distill pipeline's scratch worktrees),
 *                         so the guards stay ACTIVE everywhere else.
 *
 * This is the clean replacement for the hand-rolled global
 * carve-out pattern (`...rule, not: { cwd: VAULT_DIRS }` copies +
 * `disabledRules`), which did NOT compose across plugins: exemptions
 * ACCUMULATE (union) across plugins and config layers, and target
 * the shipped rule names — a stable public contract — so other tools
 * can carve the same guards for other repo types without touching
 * this plugin.
 *
 * Exemption clauses are STRICTLY fail-closed: `onUnknown` cannot be
 * written anywhere inside them (type-level ban + load-time
 * rejection), and unknown walker cwd never exempts — the target
 * rule's own `onUnknown:` policy decides, so the guard still fires
 * on an unresolvable cwd.
 *
 * No pi extension runtime involved: this module is a plain library
 * with a single non-builtin runtime import (`@cad0p/napkin`, itself
 * a plain library shipping compiled dist JS — all pi-steering
 * imports are type-only and erased by node's type stripping), so
 * the steering global config can import it without pi being
 * involved.
 *
 * Opt-in: nothing happens until the user lists this plugin next to
 * the git plugin:
 *
 * ```ts
 * import { defineConfig } from "@cad0p/pi-steering";
 * import gitPlugin from "@cad0p/pi-steering/plugins/git";
 * import napkinSteeringPlugin from "@cad0p/pi-napkin/steering";
 *
 * export default defineConfig({
 *   plugins: [gitPlugin, napkinSteeringPlugin],
 * });
 * ```
 *
 * `gitPlugin` MUST be listed alongside: the exemptions target its
 * rule names, and a missing target surfaces `exemption-orphan`
 * warnings with no carve-out.
 */
const napkinSteeringPlugin = {
  name: "napkin",
  predicates: {
    isNapkinVault,
  },
  exemptions: [
    { rule: "no-main-commit", when: { isNapkinVault: true } },
    { rule: "no-main-commit-github", when: { isNapkinVault: true } },
  ],
} as const satisfies Plugin;

export default napkinSteeringPlugin;

// Named re-exports for consumers that want to pick pieces (e.g. a
// test harness constructing a minimal config that uses only the
// predicate without the shipped exemptions).
export { isNapkinVault, isNapkinVaultDir, napkinSteeringPlugin };
