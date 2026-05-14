/**
 * Shared test helpers for the distill extension.
 *
 * Keep this file lightweight: small, well-scoped helpers used across
 * multiple test files. Anything that grows past ~30 LOC or pulls in
 * heavy deps probably belongs in its own file.
 */

import * as fs from "node:fs";
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
 *   - Throws if `node_modules/.bin/` doesn't exist (R8-CI-1, R8-SC-10).
 *     The previous silent-no-op behaviour caused wrapper-spawning
 *     tests to fail with the wrapper's `napkin not found on PATH`
 *     diagnostic when a developer ran `bun test` before `bun install`,
 *     pointing at the wrapper instead of at the missing setup step.
 *     Failing here surfaces the actual problem at the helper.
 *
 * Repo-root resolution: `__dirname` resolves to this helper's directory
 * (`extensions/distill/`), so `../../node_modules/.bin/` is the repo's
 * regardless of which test file imports the helper.
 */
export function withNapkinOnPath(): { restore: () => void } {
  const localBin = path.resolve(__dirname, "..", "..", "node_modules", ".bin");
  if (!fs.existsSync(localBin)) {
    throw new Error(
      `withNapkinOnPath: ${localBin} does not exist. Run \`bun install\` ` +
        `before \`bun test\` so the wrapper-spawning tests can resolve \`napkin\`.`,
    );
  }
  const saved = process.env.PATH;
  process.env.PATH = `${localBin}${path.delimiter}${process.env.PATH ?? ""}`;
  return {
    restore() {
      if (saved === undefined) delete process.env.PATH;
      else process.env.PATH = saved;
    },
  };
}
