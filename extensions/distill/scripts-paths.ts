/**
 * Path helpers for the on-disk shell scripts shipped with this extension.
 *
 * Bun-test invokes our test files with arbitrary cwd, so resolving script
 * paths via `__dirname` keeps tests robust regardless of where they're run.
 * Runtime code (distill-workspace) resolves the same paths this way.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

const _here = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the shell scripts directory (`extensions/distill/scripts`). */
export const SCRIPTS_DIR: string = path.join(_here, "scripts");

/** Absolute path to the git_retry helper (bash-sourceable). */
export const GIT_RETRY_SCRIPT: string = path.join(SCRIPTS_DIR, "git_retry.sh");

/** Absolute path to the LLM merge driver. */
export const MERGE_DRIVER_SCRIPT: string = path.join(
  SCRIPTS_DIR,
  "napkin-distill-merge",
);

/** Absolute path to the distill orchestration wrapper (bash). */
export const DISTILL_WRAPPER_SCRIPT: string = path.join(
  SCRIPTS_DIR,
  "distill-wrapper.sh",
);

/**
 * Absolute path to the legacy (git-optional) distill wrapper used by manual
 * `/distill` in vaults without git. Thin shim: runs `pi -p <prompt>` + `rm
 * -rf <tmpDir>`. Exists so the legacy spawn path uses argv-based
 * `spawn("sh", [script, ...args])` semantics instead of `sh -c`, removing
 * all shell-string interpolation from the extension.
 */
export const DISTILL_WRAPPER_LEGACY_SCRIPT: string = path.join(
  SCRIPTS_DIR,
  "distill-wrapper-legacy.sh",
);
