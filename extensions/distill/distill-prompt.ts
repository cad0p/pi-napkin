/**
 * Distill prompt loader.
 *
 * The agent-driven distill prompt lives as markdown at
 * `extensions/distill/distill-prompt.md`, with template placeholders the
 * wrapper resolves at spawn time. This module reads that .md at runtime,
 * substitutes the placeholders, and returns the resolved string for the
 * wrapper to pass to `pi -p`.
 *
 * Why markdown + a loader (PR #12 design — "DISTILL_PROMPT location"):
 *   - Easier to edit / iterate the prompt without touching code
 *   - Markdown rendering in editors makes the prompt readable as prose
 *   - Snapshot tests assert prompt content directly against the .md
 *   - Bundled with npm publish via `package.json` `files` entry
 *
 * The loader is strict on placeholder coverage: every required placeholder
 * MUST be present in the .md OR the loader throws. This protects against
 * silent drift where a refactor renames a placeholder in the .md but
 * leaves the TS-side input shape intact, sending an unresolved
 * `{{worktreePath}}` literal to the agent. Per the methodology guide's
 * never-deferrable categories, "stale references to renamed concepts" are
 * a fix-now class — failing fast at load time keeps them out of agent
 * prompts entirely.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const _here = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the distill prompt markdown file. */
export const DISTILL_PROMPT_PATH: string = path.join(
  _here,
  "distill-prompt.md",
);

/**
 * Inputs to {@link buildDistillPrompt}. All four placeholders MUST be
 * provided; passing an empty string is disallowed because that would
 * produce an agent prompt with `git merge ` (empty branch name) or
 * `cd ` (empty path) — silent corruption rather than fail-fast.
 */
export interface DistillPromptInputs {
  /** Absolute path to the per-distill git worktree. Substituted for `{{worktreePath}}`. */
  worktreePath: string;
  /** Absolute path to the main vault (the worktree's parent repo). Substituted for `{{vaultPath}}`. */
  vaultPath: string;
  /** Distill branch name, e.g. `distill/abc123-1700000000000`. Substituted for `{{branchName}}`. */
  branchName: string;
  /** Vault's default mainline branch (`main`, `master`, ...). Substituted for `{{defaultBranch}}`. */
  defaultBranch: string;
}

/**
 * Required placeholders the .md template must contain. Order matches the
 * order they appear in the template; the validator below iterates this
 * list to surface a precise diagnostic when one is missing.
 */
const REQUIRED_PLACEHOLDERS = [
  "{{worktreePath}}",
  "{{vaultPath}}",
  "{{branchName}}",
  "{{defaultBranch}}",
] as const;

/**
 * Read the distill prompt markdown and substitute placeholders.
 *
 * @throws Error if the .md file is missing, empty, or omits any required
 *         placeholder. Throws if any input value is empty (per the
 *         {@link DistillPromptInputs} contract).
 *
 * Pure function aside from the .md read: the loader does not cache, so
 * tests that mutate the file (or replace it via mocked fs) see the
 * fresh contents on each call. The .md is small (a few KB); re-reading
 * it on each spawn is cheap relative to the agent task itself (60s+).
 */
export function buildDistillPrompt(inputs: DistillPromptInputs): string {
  for (const [key, value] of Object.entries(inputs)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `buildDistillPrompt: input '${key}' must be a non-empty string (got ${JSON.stringify(value)})`,
      );
    }
  }

  let template: string;
  try {
    template = fs.readFileSync(DISTILL_PROMPT_PATH, "utf-8");
  } catch (err) {
    throw new Error(
      `buildDistillPrompt: failed to read prompt template at ${DISTILL_PROMPT_PATH}: ${(err as Error).message}`,
    );
  }
  if (template.length === 0) {
    throw new Error(
      `buildDistillPrompt: prompt template at ${DISTILL_PROMPT_PATH} is empty`,
    );
  }

  for (const placeholder of REQUIRED_PLACEHOLDERS) {
    if (!template.includes(placeholder)) {
      throw new Error(
        `buildDistillPrompt: prompt template at ${DISTILL_PROMPT_PATH} is missing required placeholder '${placeholder}'`,
      );
    }
  }

  // Map placeholder → input key. Keep this aligned with REQUIRED_PLACEHOLDERS
  // so the missing-placeholder error and the substitution loop never drift.
  const substitutions: Array<[string, string]> = [
    ["{{worktreePath}}", inputs.worktreePath],
    ["{{vaultPath}}", inputs.vaultPath],
    ["{{branchName}}", inputs.branchName],
    ["{{defaultBranch}}", inputs.defaultBranch],
  ];

  let result = template;
  for (const [placeholder, value] of substitutions) {
    // String#replaceAll on each placeholder; values are not regex-special
    // because they're filesystem paths or branch names. Even if a path
    // contained a `$` or `\`, replaceAll on a literal string (not regex)
    // is escape-safe.
    result = result.replaceAll(placeholder, value);
  }

  return result;
}
