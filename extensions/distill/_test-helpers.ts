/**
 * Shared test helpers for the distill extension.
 *
 * Keep this file lightweight: small, well-scoped helpers used across
 * multiple test files. Anything that grows past ~30 LOC or pulls in
 * heavy deps probably belongs in its own file.
 */

import * as path from "node:path";

/**
 * Augment `process.env.PATH` so the spawned wrapper can resolve `napkin`
 * via `command -v` (R7-CI-1 — the wrapper's `--version` smoke test
 * needs the binary on PATH from `node_modules/.bin/`).
 *
 * After `bun install` napkin lives at `<repo>/node_modules/.bin/napkin`
 * (a symlink with `#!/usr/bin/env node` shebang). Test environments
 * typically don't have napkin on the global PATH, so wrapper-spawning
 * tests need to prepend the local bin dir.
 *
 * Contract:
 *   - Mutates `process.env.PATH` in place. The Bun spawn API inherits
 *     the parent's env, so a wrapper spawned after the call sees the
 *     augmented PATH automatically.
 *   - Returns a `{ restore }` handle the caller MUST call (typically in
 *     `afterEach`) to revert.
 *   - Capture happens at call time (NOT module load), so each test's
 *     beforeEach gets a fresh snapshot. Avoids the brittle
 *     module-load-const pattern that R7-SC-6 / R7-CC-2 flagged.
 *   - The previous duplicated pattern across `shutdown-handler.test.ts`
 *     used per-describe `let` saves with comments about \"TDZ /
 *     shadowing pitfalls\" — that hazard doesn't actually exist for
 *     sibling describe blocks (they're separate scopes). The shared
 *     helper makes the discipline uniform without that confusion.
 *
 * Repo-root resolution: the helper is in `extensions/distill/` so
 * `../../node_modules/.bin/` is the repo's. Relative to `__dirname`
 * (the test file's, since this is a require/import dependency \u2014 same
 * dir) the same path applies for both this file and any test file in
 * the same directory.
 */
export function withNapkinOnPath(): { restore: () => void } {
  const localBin = path.resolve(__dirname, "..", "..", "node_modules", ".bin");
  const saved = process.env.PATH;
  process.env.PATH = `${localBin}${path.delimiter}${process.env.PATH ?? ""}`;
  return {
    restore() {
      if (saved === undefined) delete process.env.PATH;
      else process.env.PATH = saved;
    },
  };
}
