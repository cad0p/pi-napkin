/**
 * First-run auto-setup for auto-distill.
 *
 * Auto-distill needs the vault to be a git repo with a `.gitignore` that
 * excludes its ephemeral state (distill worktrees, Obsidian workspace-local
 * caches) and a `.gitattributes` that registers the LLM merge driver for
 * concurrent distill runs. Vaults typically ship without any of this — we
 * scaffold it at `session_start` when `distill.enabled` is true.
 *
 * Design contract:
 *   - Idempotent: re-running on an already-set-up vault is a no-op (returns
 *     `{ initialized: false, scaffolded: [] }`).
 *   - Non-destructive: never clobbers existing `.gitignore` /
 *     `.gitattributes` content; only appends missing lines.
 *   - Fail-soft: returns `{ error }` instead of throwing so the caller can
 *     surface a notify() and keep the session alive.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Lines appended to `<vault>/.gitignore` when scaffolding. Order is stable so
 * diff noise stays minimal on re-runs. Each group has a section-comment
 * header — we match on the non-comment lines for idempotence, the comments
 * are cosmetic.
 */
export const GITIGNORE_LINES: readonly string[] = [
  "# napkin-distill ephemeral state",
  ".napkin/distill/",
  "",
  "# Obsidian workspace-local state",
  ".obsidian/workspace*.json",
  ".obsidian/cache",
  ".obsidian/.trash/",
  "",
  "# Local tmp/cache",
  "search-cache.json",
  ".DS_Store",
  "",
  "# Common secrets — belt-and-braces for vaults that end up alongside dev",
  "# work. Auto-distill commits 'git add .' on first run; these patterns",
  "# keep credentials out of the initial commit even if a user's vault",
  "# happens to contain them.",
  ".env",
  ".env.local",
  ".env.*.local",
  "*.pem",
  "*.key",
  "id_rsa",
  "id_ecdsa",
  "id_ed25519",
  "secrets.json",
  ".aws/credentials",
];

/**
 * Lines appended to `<vault>/.gitattributes` when scaffolding. Registers the
 * `napkin-distill-merge` driver for every `.md` file so parallel distill
 * runs hit the LLM merge path on conflict.
 */
export const GITATTRIBUTES_LINES: readonly string[] = [
  "# napkin-distill: LLM merge driver for concurrent auto-distill",
  "*.md merge=napkin-distill-merge",
];

/**
 * Result of {@link ensureVaultReadyForAutoDistill}.
 *
 * - `initialized`: a brand-new `git init` ran (vault had no `.git/` before).
 * - `scaffolded`: files whose contents were created or modified. Callers use
 *   this to decide whether to surface a first-run notify to the user.
 * - `error`: populated on fail-soft paths (git init failed, filesystem
 *   errors writing the scaffolding). If set, other fields reflect partial
 *   progress.
 */
export interface SetupResult {
  initialized: boolean;
  scaffolded: string[];
  error?: string;
}

/**
 * Minimal vault handle this module accepts. Mirrors
 * `StaleCleanupVault` in `distill-workspace.ts` — keeps the callsite
 * symmetric: both setup and cleanup take `{ contentPath }` and neither
 * forces the caller to construct a full Napkin instance.
 */
export interface SetupVault {
  contentPath: string;
}

/**
 * Run `git` in `cwd` and return `{ status, stdout, stderr }`. Does not throw
 * on non-zero exit — we translate failures to `SetupResult.error`.
 */
function runGit(
  cwd: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
  });
  return {
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || r.error?.message || "",
  };
}

/**
 * Merge `newLines` into the file at `filePath`, appending only the
 * non-comment, non-blank lines that aren't already present. A line is
 * considered "present" if it appears verbatim anywhere in the existing file
 * (leading/trailing whitespace trimmed for comparison). Returns `true` if
 * the file was created or modified.
 *
 * Creates the file if it doesn't exist. Preserves the existing content
 * verbatim otherwise — we never rewrite or re-order user lines.
 */
function mergeLines(filePath: string, newLines: readonly string[]): boolean {
  const existed = fs.existsSync(filePath);
  const existing = existed ? fs.readFileSync(filePath, "utf-8") : "";
  const existingSet = new Set(
    existing
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#")),
  );

  const toAppend: string[] = [];
  let sawMeaningful = false;
  for (const line of newLines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      // Only keep headers/spacers if there's at least one real line to append
      // below them. We can't decide that until we've scanned the whole block,
      // so buffer optimistically and trim at the end.
      toAppend.push(line);
      continue;
    }
    if (!existingSet.has(trimmed)) {
      toAppend.push(line);
      sawMeaningful = true;
    }
  }

  if (!sawMeaningful) {
    // File already has everything meaningful — no change needed even if we
    // accumulated section headers in `toAppend`.
    return false;
  }

  // Prefix with a blank line if the existing file doesn't end with one, so
  // appended sections are visually separated.
  let prefix = "";
  if (existed && existing.length > 0 && !existing.endsWith("\n")) prefix = "\n";
  else if (existed && existing.length > 0 && !existing.endsWith("\n\n"))
    prefix = "\n";

  const body = `${toAppend.join("\n")}\n`;
  fs.writeFileSync(filePath, existing + prefix + body);
  return true;
}

/**
 * Ensure `<vaultPath>` is a git repo with a `.gitignore` / `.gitattributes`
 * that cover auto-distill's needs. Called once per `session_start` when
 * `distill.enabled` is true.
 *
 * Lifecycle:
 *   1. If `.git/` is missing → `git init`. Failure here aborts with `error`.
 *   2. Merge scaffolding lines into `.gitignore` and `.gitattributes`
 *      (idempotent; no-op if already present).
 *   3. If anything changed:
 *      - fresh init → `git add .` + commit `"napkin: initial vault commit
 *        (auto-distill setup)"`
 *      - existing repo → `git add .gitignore .gitattributes` + commit
 *        `"napkin: scaffold auto-distill git config"`
 *
 * Returned `scaffolded` always uses vault-relative paths so notify messages
 * are compact and portable.
 */
export function ensureVaultReadyForAutoDistill(vault: SetupVault): SetupResult {
  const vaultPath = vault.contentPath;
  const gitDir = path.join(vaultPath, ".git");
  let initialized = false;

  if (!fs.existsSync(gitDir)) {
    const init = runGit(vaultPath, ["init", "-q", "-b", "main"]);
    if (init.status !== 0) {
      return {
        initialized: false,
        scaffolded: [],
        error: `git init failed: ${init.stderr.trim() || "unknown error"}`,
      };
    }
    initialized = true;
  }

  const scaffolded: string[] = [];

  try {
    const giPath = path.join(vaultPath, ".gitignore");
    if (mergeLines(giPath, GITIGNORE_LINES)) scaffolded.push(".gitignore");
    const gaPath = path.join(vaultPath, ".gitattributes");
    if (mergeLines(gaPath, GITATTRIBUTES_LINES))
      scaffolded.push(".gitattributes");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      initialized,
      scaffolded,
      error: `failed to write scaffolding: ${msg}`,
    };
  }

  if (initialized) {
    // Fresh init: commit the entire vault so auto-distill has a HEAD to
    // branch from. `git add .` respects the just-written .gitignore so we
    // don't accidentally stage distill-worktrees/ etc.
    const add = runGit(vaultPath, ["add", "."]);
    if (add.status !== 0) {
      return {
        initialized,
        scaffolded,
        error: `git add failed: ${add.stderr.trim() || "unknown error"}`,
      };
    }
    const commit = runGit(vaultPath, [
      "commit",
      "-q",
      "-m",
      "napkin: initial vault commit (auto-distill setup)",
    ]);
    if (commit.status !== 0) {
      return {
        initialized,
        scaffolded,
        error: `git commit failed: ${commit.stderr.trim() || "unknown error"}`,
      };
    }
  } else if (scaffolded.length > 0) {
    // Existing repo: only stage the scaffolding files so we don't sweep in
    // the user's unrelated working changes.
    const add = runGit(vaultPath, ["add", ...scaffolded]);
    if (add.status !== 0) {
      return {
        initialized,
        scaffolded,
        error: `git add failed: ${add.stderr.trim() || "unknown error"}`,
      };
    }
    const commit = runGit(vaultPath, [
      "commit",
      "-q",
      "-m",
      "napkin: scaffold auto-distill git config",
    ]);
    if (commit.status !== 0) {
      return {
        initialized,
        scaffolded,
        error: `git commit failed: ${commit.stderr.trim() || "unknown error"}`,
      };
    }
  }

  return { initialized, scaffolded };
}

/**
 * Count the files tracked in the vault's git index. Used by the first-run
 * notify so the user sees a concrete scope ("42 files tracked") rather
 * than the abstract scaffolding list. Returns `-1` if git fails or the
 * vault isn't a repo; callers treat negative as "don't mention a count".
 */
export function countTrackedFiles(vaultPath: string): number {
  const res = runGit(vaultPath, ["ls-files"]);
  if (res.status !== 0) return -1;
  return res.stdout.split("\n").filter((l) => l.length > 0).length;
}
