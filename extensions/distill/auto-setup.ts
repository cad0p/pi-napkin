/**
 * Auto-distill health check + first-run setup for vaults.
 *
 * Auto-distill needs the vault to be a git repo with a `.gitignore`
 * that excludes its ephemeral state (distill worktrees, Obsidian
 * workspace-local caches) and (at full level) a `.napkin/config.json`
 * that is parseable and tracked by git. The same function runs at
 * `session_start` (`level: "fast"`) to enforce the cheap invariants
 * once per session, and again before every worktree-based spawn
 * (`level: "full"`) to enforce the full set including the slower
 * git probes. See {@link ensureVaultReadyForDistill} for the per-level
 * invariant matrix.
 *
 * PR #12 (agent-driven merge): pre-PR-12 auto-distill also installed
 * an `*.md merge=napkin-distill-merge` rule in `.gitattributes` to
 * route concurrent-distill conflicts through an LLM merge driver. PR
 * #12 deleted that driver — the distill agent now resolves merges
 * itself in its worktree, so the rule is no longer needed. New vaults
 * never get the rule installed. Existing vaults that already have it
 * are left alone (manual cleanup; the rule becomes inert once the
 * driver script is gone — git silently falls back to its built-in
 * merge driver). See design.md "Migration" for rationale.
 *
 * Design contract:
 *   - Idempotent: re-running on a healthy vault returns
 *     `{ initialized: false, scaffolded: [], findings: [] }` and
 *     touches nothing on disk.
 *   - In-place block reconciliation: `.gitignore` is rewritten as a
 *     `# BEGIN NAPKIN-DISTILL MANAGED` / `# END NAPKIN-DISTILL
 *     MANAGED` block. User content outside the markers is preserved
 *     byte-identically. Drift inside the markers is auto-recovered
 *     with one of four recovery flavors (`installed` / `reset` /
 *     `migrated from line-by-line` / `reset and migrated from
 *     line-by-line` — see {@link mergeManagedBlock} for the case
 *     matrix). Malformed markers refuse auto-fix and emit a
 *     loud-error finding.
 *   - Fail-soft: returns `{ error }` instead of throwing on
 *     filesystem-write or git-subprocess failures so callers can
 *     surface a notify and abort the spawn while keeping the session
 *     alive. Structured per-invariant findings live in `findings`;
 *     `error` is reserved for the fail-soft generic-failure channel
 *     that has no corresponding finding (e.g. `git init` / `git add`
 *     / `git commit` failures, EISDIR on `.gitignore` write, and the
 *     {@link LEGACY_EMBEDDED_LAYOUT_ERROR} sentinel).
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { GIT_SUBCOMMAND_TIMEOUT_MS } from "./distill-workspace";

/**
 * Snapshot of the v0.3.0 line-by-line entries appended to
 * `<vault>/.gitignore` (no markers) for vaults at v0.3.0 and earlier.
 * At v0.3.1 sessions install the managed-block format and remove
 * orphan lines matching this list; the canonical content lives in
 * {@link BLOCK_CONTENT}, which is the source of truth for the
 * managed block. This constant is retained as a migration shim for
 * one release: it is pinned by test as a strict subset of
 * {@link BLOCK_CONTENT} so a future edit that drops a v0.3.0 entry
 * from the managed block surfaces as a test failure rather than a
 * silent migration regression.
 *
 * @deprecated Replaced by {@link BLOCK_CONTENT}; will be removed in a
 *   future release once the migration window has lapsed.
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
 * Begin marker for the napkin-distill managed block in `<vault>/.gitignore`.
 * Ansible-style markers bracket the lines that auto-setup owns; everything
 * outside the markers is user territory and is never touched. The exact
 * suffix `NAPKIN-DISTILL MANAGED` is required so unrelated `# BEGIN ...`
 * comments in the user's file don't collide with our detection.
 */
export const BLOCK_MARKER_BEGIN = "# BEGIN NAPKIN-DISTILL MANAGED";

/**
 * End marker matching {@link BLOCK_MARKER_BEGIN}. See that constant for
 * the rationale on the exact suffix.
 */
export const BLOCK_MARKER_END = "# END NAPKIN-DISTILL MANAGED";

/**
 * Canonical content of the napkin-distill managed block. Auto-setup
 * rewrites the bracketed region to match this verbatim whenever drift
 * is detected (lines added, removed, reordered, or modified).
 *
 * Strict superset of {@link GITIGNORE_LINES}: every non-blank,
 * non-comment entry in `GITIGNORE_LINES` is present here. Test
 * coverage pins the relationship so future edits to either constant
 * surface as a test failure.
 */
export const BLOCK_CONTENT: readonly string[] = [
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
 * Depth of the health check run. Each call site explicitly chooses one;
 * there is no default.
 *
 * - `"fast"`: file-only invariants and the cheapest necessary git
 *   invocations. Suitable for `session_start`, where added latency is
 *   user-visible. Target ~10 ms.
 * - `"full"`: superset of `"fast"` plus git-state probes, filesystem
 *   probes, and orphan cleanup. Suitable for the moments immediately
 *   before a worktree-based distill is spawned, where the LLM prelude
 *   masks tens of milliseconds. Target ~50–100 ms.
 */
export type HealthLevel = "fast" | "full";

/**
 * Outcome of a single named health-check invariant.
 *
 * - `kind: "auto-recovered"`: the invariant was violated but `auto-setup`
 *   restored the expected state in place. Surface as an info notify; the
 *   caller proceeds with the distill spawn.
 * - `kind: "error"`: the invariant was violated and recovery is owned by
 *   the user (e.g. legacy layout migration, malformed JSON). Surface as
 *   an error notify; the caller aborts the distill spawn.
 * - `invariant`: stable identifier for the check. One ID per check; the
 *   per-flavor recovery messaging lives in `recovery`.
 * - `message`: human-readable description, suitable for notify text.
 * - `recovery`: populated for `auto-recovered` findings; describes what
 *   was done (e.g. `"git add .napkin/config.json"`,
 *   `"installed managed gitignore block"`).
 */
export interface HealthFinding {
  kind: "auto-recovered" | "error";
  invariant: string;
  message: string;
  recovery?: string;
}

/**
 * Result of {@link ensureVaultReadyForDistill}.
 *
 * - `initialized`: a brand-new `git init` ran (vault had no `.git/` before).
 * - `scaffolded`: files whose contents were created or modified. Callers use
 *   this to decide whether to surface a first-run notify to the user.
 * - `error`: populated on fail-soft paths (git init failed, filesystem
 *   errors writing the scaffolding, legacy-layout refusal). If set, other
 *   fields reflect partial progress. Consumed at all extension call sites
 *   (session_start, runDistill, runAutoDistill, session_shutdown handler)
 *   to surface a `notify("error")` and abort the spawn; the legacy-embedded
 *   path additionally compares against {@link LEGACY_EMBEDDED_LAYOUT_ERROR}.
 * - `legacyLayout`: populated when auto-setup refused to scaffold because
 *   the vault is using napkin's legacy embedded layout (`configPath ===
 *   contentPath`). The worktree-based concurrency architecture relies on
 *   napkin's findVault resolving cwd=worktree to the worktree itself —
 *   which only works for subdir-layout vaults (those that track a
 *   `.napkin/config.json`). `error` is set to `"legacy-embedded-layout"`
 *   so callers can branch on it.
 * - `findings`: structured per-invariant outcomes. Always present (empty
 *   array means "all invariants passed"). Callers iterate to surface
 *   notifications and decide whether to abort spawning.
 */
export interface SetupResult {
  initialized: boolean;
  scaffolded: string[];
  error?: string;
  legacyLayout?: {
    /** Absolute path to the vault's `.napkin/` (= contentPath for legacy). */
    configPath: string;
  };
  /**
   * Set to `true` when the vault had a `.git/` but no commits (HEAD
   * unresolvable) and auto-setup synthesized an empty initial commit to
   * make HEAD valid. Distinct from `initialized` (which is "we ran
   * `git init`"): this path fires on an existing-but-empty repo where
   * someone ran `git init` by hand and never committed. Without the
   * seed, `git worktree add ... HEAD` in createDistillWorktree would
   * fail with `fatal: invalid reference: HEAD` — the bug that
   * motivated FB-2.
   */
  seededCommit?: boolean;
  findings: readonly HealthFinding[];
}

/**
 * Sentinel value set in `SetupResult.error` when auto-setup refuses to
 * scaffold because the vault is using napkin's legacy embedded layout.
 * Exported so callers (session_start handler, tests) can branch on the
 * exact sentinel instead of pattern-matching on the free-form message.
 */
export const LEGACY_EMBEDDED_LAYOUT_ERROR = "legacy-embedded-layout";

/**
 * Minimal vault handle this module accepts. Mirrors
 * `StaleCleanupVault` in `distill-workspace.ts` — keeps the callsite
 * symmetric: both setup and cleanup take the same vault shape and
 * neither forces the caller to construct a full Napkin instance.
 *
 * Both paths are required: legacy-embedded-layout detection needs to
 * compare `configPath` and `contentPath` directly (legacy vaults have
 * them equal; subdir vaults have them distinct).
 */
export interface SetupVault {
  contentPath: string;
  configPath: string;
}

/**
 * Run `git` in `cwd` and return `{ status, stdout, stderr }`. Does not throw
 * on non-zero exit — we translate failures to `SetupResult.error`.
 */
function runGit(
  cwd: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  // `env: process.env` is required for Bun: unlike Node, Bun's spawnSync
  // does NOT propagate mutations to `process.env` to the child unless
  // `env` is passed explicitly (it snapshots env at runtime startup).
  // Passing process.env here is a no-op on Node and restores Node-compat
  // semantics on Bun so tests can control git identity via env vars.
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: GIT_SUBCOMMAND_TIMEOUT_MS,
    env: process.env,
  });
  return {
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || r.error?.message || "",
  };
}

/**
 * Stable invariant ID for the managed-block check. Auto-recovered
 * findings carry recovery text describing which flavor fired
 * (`installed`, `reset`, `migrated from line-by-line`, or the compound
 * `reset and migrated from line-by-line` when both drift and orphan
 * lines fire on the same pass — see {@link mergeManagedBlock} for the
 * case matrix); error findings indicate the markers are malformed and
 * require manual resolution.
 */
const INVARIANT_GITIGNORE_BLOCK = "gitignore-block-correct";

/**
 * Stable invariant ID for the layout check. Loud-error finding only;
 * legacy-embedded vaults require manual migration to the subdir layout.
 */
const INVARIANT_SUBDIR_LAYOUT = "subdir-layout";

/**
 * Stable invariant ID for the git-repo presence check. Auto-recovered
 * via `git init -q -b main` when `.git/` is absent.
 */
const INVARIANT_VAULT_IS_GIT_REPO = "vault-is-git-repo";

/**
 * Stable invariant ID for `<configPath>/config.json` JSON validity.
 * Loud-error finding only — a corrupt config is the user's hand-edit and
 * we can't guess the intended content.
 */
const INVARIANT_CONFIG_JSON_VALID = "config.json-valid-json";

/**
 * Stable invariant ID for `<configPath>/config.json` being tracked by
 * git. Auto-recovered via `git add <configRel>`; the existing
 * scaffolded[] consumption stages and commits the file on the same
 * pass. Untracked config.json is the root cause of Issue #14: distill
 * worktrees are checked out via `git worktree add HEAD`, which copies
 * only tracked files, so untracked config.json never reaches the
 * worktree and napkin's findVault falls back to legacy embedded layout.
 */
const INVARIANT_CONFIG_JSON_TRACKED = "config.json-tracked";

/**
 * Stable invariant ID for `<configPath>/config.json` NOT being
 * gitignored by a rule that lives outside the napkin-distill managed
 * block. Loud-error finding only — the user added the rule explicitly
 * and we cannot guess whether removing it would lose track of an
 * intentional choice. The inside-block flavor is a no-op for this
 * invariant: the canonical {@link BLOCK_CONTENT} does NOT gitignore
 * `config.json`, and the {@link INVARIANT_GITIGNORE_BLOCK} reset
 * automatically removes any drift inside the markers on the next
 * pass.
 */
const INVARIANT_CONFIG_JSON_NOT_GITIGNORED_OUTSIDE_BLOCK =
  "config.json-not-gitignored-outside-block";

/**
 * Range of the napkin-distill managed block within `<vault>/.gitignore`,
 * in 1-indexed line numbers (matching `git check-ignore -v` output).
 * `beginLine` points at the BEGIN marker; `endLine` at the END marker;
 * the canonical-content lines live STRICTLY between them.
 *
 * `null` when the file is missing or the markers are absent / malformed
 * — the gitignore-block invariant handles the recovery for those
 * cases on the next pass.
 */
interface ManagedBlockRange {
  beginLine: number;
  endLine: number;
}

/**
 * Read `<giPath>` and locate the napkin-distill managed-block markers.
 * Returns `null` if the file is missing, the markers are absent, or
 * the markers are malformed (multiple BEGINs, BEGIN without matching
 * END, END before BEGIN). The malformed cases are handled by
 * {@link mergeManagedBlock}'s loud-error finding on the same pass; this
 * helper's `null` return signals the caller to skip the inside-block
 * test (treating the line as outside the block, which is the
 * conservative default).
 *
 * Marker matching mirrors {@link mergeManagedBlock}: right-trimmed
 * exact match against {@link BLOCK_MARKER_BEGIN} / {@link
 * BLOCK_MARKER_END}, leading whitespace not tolerated.
 */
export function parseManagedBlockRange(
  giPath: string,
): ManagedBlockRange | null {
  if (!fs.existsSync(giPath)) return null;
  const content = fs.readFileSync(giPath, "utf-8");
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.length > 0 ? content.split(eol) : [];
  let begin = -1;
  let end = -1;
  let beginCount = 0;
  let endCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const rtrimmed = lines[i].replace(/\s+$/, "");
    if (rtrimmed === BLOCK_MARKER_BEGIN) {
      begin = i;
      beginCount++;
    } else if (rtrimmed === BLOCK_MARKER_END) {
      end = i;
      endCount++;
    }
  }
  if (beginCount !== 1 || endCount !== 1 || begin >= end) return null;
  // Convert to 1-indexed (matches `git check-ignore -v` line numbers).
  return { beginLine: begin + 1, endLine: end + 1 };
}

/**
 * Test whether the gitignore rule at `<source>:<line>` lives strictly
 * inside the managed block defined by `range`. The block markers
 * themselves are gitignore comments (no-op as patterns) so they will
 * not appear in `git check-ignore -v` output; only lines strictly
 * between the markers can be inside the block.
 *
 * `source` is the gitignore source path reported by `git check-ignore
 * -v`; only matches `.gitignore` (the file the managed block lives
 * in) are eligible to be inside the block. Other sources — a global
 * `~/.config/git/ignore`, a parent-directory `.gitignore`, an info/
 * exclude — are by definition outside our managed block, so we
 * report them as outside.
 *
 * Caller passes `null` for `range` when the markers are missing or
 * malformed; in that case every gitignore rule is treated as outside
 * the block (conservative default; the gitignore-block invariant
 * handles the recovery for those cases on the next pass).
 */
export function isLineInsideBlock(
  source: string,
  line: number,
  range: ManagedBlockRange | null,
): boolean {
  if (range === null) return false;
  if (source !== ".gitignore") return false;
  return line > range.beginLine && line < range.endLine;
}

/**
 * Parsed output of `git check-ignore -v`. Format documented in `man
 * git-check-ignore`: `<source> <COLON> <linenum> <COLON> <pattern> <HT>
 * <pathname>`. The first separator before the pathname is a TAB; the
 * source-side fields are colon-separated, with the line number in the
 * middle anchoring the parse (`source` may itself contain colons on
 * absolute Windows paths or when sourced from absolute global ignore
 * files).
 *
 * Returns `null` when the line does not match the expected `-v` shape
 * — conservative, since `git check-ignore` exited 0 so the path IS
 * ignored; we just can't determine where the rule lives. Caller
 * should treat as outside-block in that case (loud error).
 */
export function parseCheckIgnoreVerbose(
  stdoutLine: string,
): { source: string; line: number; pattern: string; pathname: string } | null {
  const tabIdx = stdoutLine.indexOf("\t");
  if (tabIdx < 0) return null;
  const matchInfo = stdoutLine.slice(0, tabIdx);
  const pathname = stdoutLine.slice(tabIdx + 1);
  // Greedy `.+` on source so absolute paths with colons match;
  // anchored on the line-number `\d+` in the middle so the parse
  // remains unambiguous when source/pattern themselves contain
  // colons.
  const m = matchInfo.match(/^(.+):(\d+):(.*)$/);
  if (!m) return null;
  return {
    source: m[1],
    line: parseInt(m[2], 10),
    pattern: m[3],
    pathname,
  };
}

/**
 * Internal result of {@link mergeManagedBlock}.
 *
 * - `changed`: whether the file was created or modified. Callers append
 *   `.gitignore` to `scaffolded` when this is `true` so the existing-repo
 *   commit branch picks up the change.
 * - `finding`: the structured outcome to surface to the user (auto-
 *   recovered for any successful rewrite; error for malformed markers).
 *   Absent on the idempotent no-op path.
 */
interface BlockMergeResult {
  changed: boolean;
  finding?: HealthFinding;
}

/**
 * Reconcile `<filePath>` with a `BEGIN/END`-bracketed canonical block. The
 * file is split into three regions: lines before BEGIN, the bracketed
 * block, and lines after END. Only the bracketed region is rewritten;
 * everything outside is user territory and is preserved byte-identically.
 *
 * Modes (single pass):
 *   - Markers absent + no orphan canonical lines elsewhere: install the
 *     block at the end of the file (`installed`).
 *   - Markers absent + orphan lines in the file matching canonical content:
 *     remove orphans + install the block (`migrated from line-by-line`).
 *     Covers the v0.3.0 → v0.3.1 line-by-line-to-managed-block migration.
 *   - One BEGIN before one END + content matches canonical + no orphans
 *     outside: idempotent no-op.
 *   - One BEGIN before one END + content drifts (added / removed / reordered
 *     entries) + no orphans outside: rewrite the bracketed region in
 *     place (`reset`).
 *   - One BEGIN before one END + content matches canonical + orphan
 *     canonical lines outside: strip the orphans, leave the bracketed
 *     region untouched (`migrated from line-by-line`). Covers the
 *     partial-migration shape where a previous run installed the block
 *     and a later edit re-introduced duplicates above it.
 *   - One BEGIN before one END + content drifts + orphan canonical lines
 *     outside: rewrite the bracketed region AND strip the orphans on
 *     the same pass (`reset and migrated from line-by-line`). Compound
 *     case for vaults that drifted inside the block while also keeping
 *     stray duplicates outside.
 *   - Multiple BEGIN markers, one without a matching END, or END before
 *     BEGIN: malformed. Emit a loud-error finding and leave the file
 *     untouched so the user can resolve manually.
 *
 * Marker matching requires the exact suffix (configured via the
 * `beginMarker` / `endMarker` arguments) so unrelated `# BEGIN ...`-style
 * markers in user content do not collide with our detection.
 */
function mergeManagedBlock(
  filePath: string,
  beginMarker: string,
  endMarker: string,
  blockContent: readonly string[],
): BlockMergeResult {
  const existed = fs.existsSync(filePath);
  const existing = existed ? fs.readFileSync(filePath, "utf-8") : "";
  // Detect the existing file's line-ending convention so we can
  // round-trip it on write. Windows-checkout vaults often store
  // `.gitignore` with CRLF; rewriting with bare LF would silently
  // strip the `\r` from every line and look like spurious churn in
  // git diffs. Default to LF for new files (matches the rest of the
  // repo's TS-code conventions).
  const eol: "\n" | "\r\n" = existing.includes("\r\n") ? "\r\n" : "\n";
  // Split into lines while preserving the trailing-newline shape: a
  // file ending in EOL produces a trailing empty element from `split`,
  // which `join` reproduces faithfully on write. Empty file (no bytes
  // OR no trailing newline) is normalised to an empty array.
  const lines = existing.length > 0 ? existing.split(eol) : [];
  const hadTrailingNewline = existing.endsWith(eol);
  // Drop the trailing empty produced by `split` on `...EOL`; we'll restore
  // the newline at write time. Keeps `lines` a clean array of content lines.
  if (hadTrailingNewline && lines.length > 0 && lines[lines.length - 1] === "")
    lines.pop();

  // Locate markers (compare on right-trimmed content to tolerate trailing
  // whitespace, but reject leading whitespace — indented markers are not
  // ours and shouldn't match).
  const beginIndices: number[] = [];
  const endIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const rtrimmed = lines[i].replace(/\s+$/, "");
    if (rtrimmed === beginMarker) beginIndices.push(i);
    else if (rtrimmed === endMarker) endIndices.push(i);
  }

  const wellFormed =
    beginIndices.length === 1 &&
    endIndices.length === 1 &&
    beginIndices[0] < endIndices[0];
  const markersAbsent = beginIndices.length === 0 && endIndices.length === 0;

  if (!wellFormed && !markersAbsent) {
    // Multiple BEGINs, BEGIN without END, or END before BEGIN. Refuse to
    // touch the file — a heuristic auto-fix risks shredding user content.
    return {
      changed: false,
      finding: {
        kind: "error",
        invariant: INVARIANT_GITIGNORE_BLOCK,
        message: `${filePath} contains malformed napkin-distill managed-block markers; resolve manually before distill can proceed.`,
      },
    };
  }

  // Set of canonical non-blank, non-comment entries. Used to detect
  // orphan lines anywhere outside the managed block (line-by-line
  // residue from v0.3.0).
  const canonicalNonComment = new Set(
    blockContent
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#")),
  );

  const writeFile = (out: string[]): void => {
    const body = out.join(eol);
    // POSIX convention: gitignore ends with a newline. Always emit one
    // (in the file's detected EOL) when we're rewriting; it's harmless
    // if the original already had one and a fix-up if it didn't.
    fs.writeFileSync(filePath, body.endsWith(eol) ? body : `${body}${eol}`);
  };

  if (markersAbsent) {
    // Identify orphan canonical lines anywhere in the file and drop
    // them; then append the block.
    const orphanIndices = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (canonicalNonComment.has(trimmed)) orphanIndices.add(i);
    }

    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!orphanIndices.has(i)) out.push(lines[i]);
    }
    // Visual separator between user content and the appended block:
    // ensure a single blank line precedes BEGIN if the file had any
    // content left.
    if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
    out.push(beginMarker, ...blockContent, endMarker);
    writeFile(out);

    const flavor =
      orphanIndices.size > 0 ? "migrated from line-by-line" : "installed";
    return {
      changed: true,
      finding: {
        kind: "auto-recovered",
        invariant: INVARIANT_GITIGNORE_BLOCK,
        message:
          flavor === "migrated from line-by-line"
            ? `${filePath} had unmanaged napkin-distill entries; migrated to managed block.`
            : `${filePath} did not contain a napkin-distill managed block; installed.`,
        recovery: flavor,
      },
    };
  }

  // Markers well-formed: compare bracketed content vs canonical, and
  // sweep for orphans outside the block.
  const beginIdx = beginIndices[0];
  const endIdx = endIndices[0];
  const blockLines = lines.slice(beginIdx + 1, endIdx);
  const blockMatches =
    blockLines.length === blockContent.length &&
    blockLines.every(
      (l, i) => l.replace(/\s+$/, "") === blockContent[i].replace(/\s+$/, ""),
    );

  const orphanOutside = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (i >= beginIdx && i <= endIdx) continue;
    const trimmed = lines[i].trim();
    if (canonicalNonComment.has(trimmed)) orphanOutside.add(i);
  }

  if (blockMatches && orphanOutside.size === 0) {
    return { changed: false };
  }

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === beginIdx) {
      out.push(beginMarker, ...blockContent, endMarker);
      i = endIdx;
      continue;
    }
    if (orphanOutside.has(i)) continue;
    out.push(lines[i]);
  }
  writeFile(out);

  let recovery: string;
  let message: string;
  if (!blockMatches && orphanOutside.size > 0) {
    recovery = "reset and migrated from line-by-line";
    message = `${filePath} managed block drifted and orphan canonical lines were present outside it; reset block and removed orphans.`;
  } else if (!blockMatches) {
    recovery = "reset";
    message = `${filePath} managed block content drifted from canonical; reset in place.`;
  } else {
    recovery = "migrated from line-by-line";
    message = `${filePath} had orphan canonical lines outside the managed block; removed.`;
  }
  return {
    changed: true,
    finding: {
      kind: "auto-recovered",
      invariant: INVARIANT_GITIGNORE_BLOCK,
      message,
      recovery,
    },
  };
}

/**
 * Ensure `<vaultPath>` is a git repo with a `.gitignore` that covers
 * distill's needs and (at full level) tracks `<configPath>/config.json`.
 * Called at `session_start` (`level: "fast"`) and again before every
 * worktree-based spawn (`level: "full"`).
 *
 * Lifecycle (in execution order; per-step level scope noted):
 *   0. fast + full: refuse if the vault uses napkin's legacy embedded
 *      layout (`configPath === contentPath`). Worktree-based concurrency
 *      doesn't work on legacy layouts because the branch can't track a
 *      `.napkin/` subdir that findVault could resolve to. Returns
 *      `{ error: "legacy-embedded-layout", legacyLayout, findings:
 *      [subdir-layout error] }` without touching git.
 *   1. fast + full: validate `<configPath>/config.json` is parseable
 *      (`config.json-valid-json`). On parse failure, push a loud-error
 *      finding and continue (the file is the user's hand-edit; we can
 *      neither auto-correct nor proceed past the smoke check).
 *   2. fast + full: if `.git/` is missing, run `git init -q -b main`
 *      (`vault-is-git-repo`, auto-recovered). Failure here aborts with
 *      `error`.
 *   3. fast + full: reconcile `.gitignore` against the canonical managed
 *      block (`gitignore-block-correct`). Auto-recovered for
 *      install / reset / migration; loud-error for malformed markers.
 *   4. full only: if `<configPath>/config.json` is untracked, stage it
 *      (`config.json-tracked`, auto-recovered) so the next
 *      `git worktree add HEAD` copies it into the worktree. Closes
 *      Issue #14. Skipped at fast level to keep session_start latency
 *      under the ~10 ms target.
 *   5. fast + full: if anything in steps 2–4 changed:
 *      - fresh init -> `git add .` + commit `"napkin: initial vault
 *        commit (auto-distill setup)"`
 *      - existing repo with scaffolded changes -> `git add ...scaffolded`
 *        + commit `"napkin: scaffold auto-distill git config"`
 *   6. fast + full: ensure HEAD resolves to a commit; seed an empty
 *      initial commit when an existing-but-empty repo would leave
 *      `git worktree add HEAD` unable to pin a ref.
 *
 * Returned `scaffolded` always uses vault-relative paths so notify
 * messages are compact and portable.
 */
export function ensureVaultReadyForDistill(
  vault: SetupVault,
  level: HealthLevel,
): SetupResult {
  const vaultPath = vault.contentPath;
  const findings: HealthFinding[] = [];

  // Legacy-embedded layout is incompatible with the worktree-based
  // concurrency architecture. In a legacy vault (`~/.napkin/`), the
  // vault IS the `.napkin/` directory — `configPath === contentPath`.
  // When a distill subprocess runs with `cwd = worktree` (a checkout of
  // a `distill/*` branch that does NOT track a `.napkin/` subdir),
  // napkin's `findVault` walks past the worktree and resolves to the
  // user's REAL vault via the global config fallback. Writes bypass the
  // worktree entirely, making the concurrency guarantee a no-op.
  //
  // Refuse to scaffold here so session_start can surface a migration
  // notify. Manual `/distill` still works on any layout (it doesn't go
  // through this path).
  //
  // Detection mirrors napkin's own `resolveVaultLayout` semantics: subdir
  // layout sets `contentPath` via `vault.root` (distinct from `configPath`),
  // while legacy embedded layout has no `vault.root` and defaults both to
  // the `.napkin/` dir. See `@cad0p/napkin` `dist/utils/vault.js`.
  if (vault.configPath === vault.contentPath) {
    findings.push({
      kind: "error",
      invariant: INVARIANT_SUBDIR_LAYOUT,
      message: `Vault at ${vaultPath} uses the legacy embedded layout (configPath === contentPath); auto-distill requires the subdir layout.`,
    });
    return {
      initialized: false,
      scaffolded: [],
      error: LEGACY_EMBEDDED_LAYOUT_ERROR,
      legacyLayout: { configPath: vault.configPath },
      findings,
    };
  }

  // `<configPath>/config.json` JSON validity. The file is the user's
  // hand-edited (or napkin-generated) source of truth for vault config;
  // a parse failure means later napkin operations will silently fall
  // back to defaults or crash. Skip the check if the file doesn't
  // exist — the missing-file case is handled at scaffold time, not
  // here. We probe it before `git init` so a corrupt config doesn't get
  // smuggled into the initial commit.
  const configJsonPath = path.join(vault.configPath, "config.json");
  if (fs.existsSync(configJsonPath)) {
    try {
      JSON.parse(fs.readFileSync(configJsonPath, "utf-8"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      findings.push({
        kind: "error",
        invariant: INVARIANT_CONFIG_JSON_VALID,
        message: `${configJsonPath} is not valid JSON: ${msg}`,
      });
    }
  }

  const gitDir = path.join(vaultPath, ".git");
  let initialized = false;

  if (!fs.existsSync(gitDir)) {
    const init = runGit(vaultPath, ["init", "-q", "-b", "main"]);
    if (init.status !== 0) {
      return {
        initialized: false,
        scaffolded: [],
        error: `git init failed: ${init.stderr.trim() || "unknown error"}`,
        findings,
      };
    }
    initialized = true;
    findings.push({
      kind: "auto-recovered",
      invariant: INVARIANT_VAULT_IS_GIT_REPO,
      message: `Initialized git repo at ${vaultPath}.`,
      recovery: "ran git init",
    });
  }

  const scaffolded: string[] = [];

  try {
    const giPath = path.join(vaultPath, ".gitignore");
    const blockResult = mergeManagedBlock(
      giPath,
      BLOCK_MARKER_BEGIN,
      BLOCK_MARKER_END,
      BLOCK_CONTENT,
    );
    if (blockResult.changed) scaffolded.push(".gitignore");
    if (blockResult.finding) findings.push(blockResult.finding);
    // PR #12: no `.gitattributes` scaffolding. Pre-PR-12 we wrote an
    // `*.md merge=napkin-distill-merge` line; the agent-driven merge
    // architecture has no driver to register.
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      initialized,
      scaffolded,
      error: `failed to write scaffolding: ${msg}`,
      findings,
    };
  }

  // Full-level only: confirm `<configPath>/config.json` is tracked by
  // git. Distill worktrees are checked out via `git worktree add HEAD`
  // which only copies tracked files — an untracked config.json never
  // reaches the worktree and napkin's findVault falls back to legacy
  // embedded layout. Closes Issue #14. Auto-recovers by adding the file
  // to scaffolded[] so the existing-repo branch below stages and
  // commits it on the same pass.
  if (level === "full") {
    const configRel = path.relative(
      vaultPath,
      path.join(vault.configPath, "config.json"),
    );
    if (fs.existsSync(path.join(vaultPath, configRel))) {
      const tracked = runGit(vaultPath, [
        "ls-files",
        "--error-unmatch",
        configRel,
      ]);
      if (tracked.status !== 0) {
        scaffolded.push(configRel);
        findings.push({
          kind: "auto-recovered",
          invariant: INVARIANT_CONFIG_JSON_TRACKED,
          message: `${configRel} was untracked; staged for commit.`,
          recovery: `git add ${configRel}`,
        });
      }

      // Refuse to spawn if the user gitignored `config.json` outside
      // the napkin-distill managed block. Inside-block drift is
      // handled automatically by the gitignore-block reset (the
      // canonical block does not gitignore `config.json`); outside-
      // block rules are explicit user choices, so we surface a loud
      // error and let the user decide. The check fires regardless of
      // whether the file is currently tracked: a user-added rule is
      // a hazard either way (a future `git rm --cached` would
      // silently re-untrack the file and the worktree-copy path
      // breaks).
      const ignored = runGit(vaultPath, [
        "check-ignore",
        "-v",
        "--no-index",
        configRel,
      ]);
      if (ignored.status === 0) {
        const giPathFull = path.join(vaultPath, ".gitignore");
        const blockRange = parseManagedBlockRange(giPathFull);
        // `check-ignore -v` may emit one rule per line for paths matched
        // by multiple ignores (rare; only the last one wins as the
        // effective rule, but earlier matches are still reported).
        // Walk every line; if ANY rule is outside the managed block
        // we surface the error — a user-territory rule is a hazard
        // even if a managed-block rule also matches.
        for (const line of ignored.stdout.split("\n")) {
          if (line.length === 0) continue;
          const parsed = parseCheckIgnoreVerbose(line);
          if (!parsed) continue;
          if (!isLineInsideBlock(parsed.source, parsed.line, blockRange)) {
            findings.push({
              kind: "error",
              invariant: INVARIANT_CONFIG_JSON_NOT_GITIGNORED_OUTSIDE_BLOCK,
              message: `${configRel} is gitignored at ${parsed.source}:${parsed.line} (outside the napkin-distill managed block); auto-distill cannot track it. Remove the rule from ${parsed.source} or restart pi after fixing it.`,
            });
            break;
          }
        }
      }
    }
  }

  if (initialized) {
    // Fresh init: commit the entire vault so auto-distill has a HEAD to
    // branch from. `git add .` respects the just-written .gitignore so we
    // don't accidentally stage `.napkin/distill/` (the per-worktree
    // session fork) or common secret files (see BLOCK_CONTENT). Distill
    // worktrees themselves live OUTSIDE the vault now (XDG cache), so
    // there's no in-vault worktrees/ path to exclude.
    const add = runGit(vaultPath, ["add", "."]);
    if (add.status !== 0) {
      return {
        initialized,
        scaffolded,
        error: `git add failed: ${add.stderr.trim() || "unknown error"}`,
        findings,
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
        findings,
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
        findings,
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
        findings,
      };
    }
  }

  // HEAD-valid invariant: createDistillWorktree requires HEAD to resolve
  // to a commit. The paths above (fresh init OR existing repo + scaffolded
  // files) produce a commit; the idempotent path (existing repo, nothing
  // to scaffold) does NOT — so a vault where someone ran `git init` by
  // hand and never committed leaves HEAD unresolvable. Seed an empty
  // initial commit so `git worktree add ... HEAD` has something to pin to.
  // This also covers the narrow window where `git init` succeeded above
  // (we set `initialized = true`) but scaffolding wrote zero lines
  // (`.gitignore` already present with our exact content) — that would
  // fall into neither branch and leave a commit-less repo.
  let seededCommit: SetupResult["seededCommit"];
  const headAfter = runGit(vaultPath, ["rev-parse", "--verify", "HEAD"]);
  if (headAfter.status !== 0) {
    const seed = runGit(vaultPath, [
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "napkin: initial vault commit (auto-distill setup)",
    ]);
    if (seed.status !== 0) {
      return {
        initialized,
        scaffolded,
        error: `git seed commit failed: ${seed.stderr.trim() || "unknown error"}`,
        findings,
      };
    }
    seededCommit = true;
  }

  return { initialized, scaffolded, seededCommit, findings };
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
