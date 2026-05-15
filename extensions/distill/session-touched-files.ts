/**
 * File-write detection for the distill overlap-notice mechanism.
 *
 * Adapted from pi's internal `extractFileOpsFromMessage`:
 *   @earendil-works/pi-coding-agent@0.74.0
 *   dist/core/compaction/utils.js — `extractFileOpsFromMessage`
 *
 * That function is not exported from pi's public API, so we reimplement
 * the small subset we need (just the file-mutation part). Sync with pi
 * upstream when the tool catalog changes — if pi adds a new write-class
 * tool (or renames "write"/"edit"), update WRITE_CLASS_TOOLS accordingly.
 *
 * A companion sanity test (session-touched-files.version-check.test.ts)
 * asserts the upstream function is still present at the expected path, so
 * a regression is caught at test time rather than silently diverging.
 *
 * // Reimplemented from pi's internal extractFileOpsFromMessage
 * // Original: @earendil-works/pi-coding-agent ^0.74.0
 * // dist/core/compaction/utils.js — extractFileOpsFromMessage / computeFileLists
 * // Not exported; sync with pi upstream when tool catalog changes.
 *
 * Used by `postOverlapNoticeOnCompletion` in extensions/distill/index.ts
 * (per-distill-completion trigger, R7-PERF-2 redesign): walks the
 * parent session's entries since the previous distill's completion to
 * compute which files the parent has written, then intersects with the
 * just-completed distill's touched files (`git log --name-only
 * <startSha>..HEAD` from the main vault).
 *
 * Responsibility split:
 *   - `extractFileOpsFromMessage`: pure, per-message, returns paths. No
 *     I/O, no state — friendly for unit tests.
 *   - `getSessionTouchedFiles`: walks a SessionEntriesSource's entries,
 *     unions the per-message paths, returns a deduped `Set<string>`.
 *     Callers can pass a slice-bounded source to scope the walk to a
 *     subrange of entries.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Tool names that mutate files, as used by pi's built-in tools. Kept in one
 * place so the version-pin test can assert it matches upstream.
 *
 * Pi's `extractFileOpsFromMessage` tracks "read" separately from write/edit
 * for a context-aware truncation pass; for overlap detection we only care
 * about files that were *written*, so "read" is intentionally excluded.
 *
 * Exported so tests can round-trip the set.
 */
export const WRITE_CLASS_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "edit",
]);

/**
 * Minimal tool-call shape used here. Intentionally structural so this file
 * doesn't need a tight coupling to pi-ai's AssistantMessage internals —
 * those types evolve across pi minor versions and we want the version-
 * check test (not the compiler) to be the pin signal.
 */
interface ToolCallLike {
  type: "toolCall";
  name: string;
  arguments?: unknown;
}

function isToolCall(block: unknown): block is ToolCallLike {
  return (
    typeof block === "object" &&
    block !== null &&
    "type" in block &&
    (block as { type?: unknown }).type === "toolCall" &&
    typeof (block as { name?: unknown }).name === "string"
  );
}

/**
 * Assistant-message shape this file actually depends on.
 */
interface AssistantMessageShape {
  role: string;
  content?: unknown;
}

/**
 * Walk an assistant message's content blocks and return the file paths
 * referenced by any write-class tool call. Best-effort:
 *   - Only looks at blocks with `type === "toolCall"`.
 *   - Only considers tool names in `WRITE_CLASS_TOOLS`.
 *   - Extracts `arguments.path` when it's a string (pi's Write/Edit both
 *     use `path` as the canonical key).
 *   - Also detects a narrow class of bash redirection patterns
 *     (`> path`, `>> path`, `tee path`) so an agent that shells out for
 *     writes isn't invisible to overlap detection.
 *
 * Duplicates ARE NOT deduped here — callers union with a Set.
 *
 * Returns an empty array for non-assistant messages and for assistant
 * messages without any qualifying tool calls.
 */
export function extractFileOpsFromMessage(
  msg: AssistantMessageShape,
): string[] {
  if (msg.role !== "assistant") return [];
  if (!Array.isArray(msg.content)) return [];

  const paths: string[] = [];
  for (const block of msg.content) {
    if (!isToolCall(block)) continue;
    const args = block.arguments;
    if (!args || typeof args !== "object") continue;

    // Write/Edit class: extract `path` if it's a string.
    if (WRITE_CLASS_TOOLS.has(block.name)) {
      const p = (args as { path?: unknown }).path;
      if (typeof p === "string" && p.length > 0) paths.push(p);
      continue;
    }

    // Bash: try to pick out common redirection targets. Deliberately
    // conservative — a bash command can do anything, so overlap detection
    // for bash-driven writes is a best-effort heuristic, not a promise.
    if (block.name === "bash") {
      const cmd = (args as { command?: unknown }).command;
      if (typeof cmd !== "string") continue;
      for (const p of extractBashRedirectionTargets(cmd)) paths.push(p);
    }
  }
  return paths;
}

/**
 * Very narrow heuristic: spot shell commands that write to a file via
 * `>`, `>>`, or `tee`. Only captures the FIRST target on each operator to
 * keep false-positives low. Quoted paths are stripped of their outer
 * single or double quotes; shell escapes are left alone (caller treats
 * paths as opaque identifiers).
 *
 * Examples that match:
 *   echo hi > foo.txt                    → ["foo.txt"]
 *   cat a.md >> log.txt                  → ["log.txt"]
 *   make 2>&1 | tee /tmp/build.log       → ["/tmp/build.log"]
 *   echo x > "path with spaces.md"       → ["path with spaces.md"]
 *
 * Does NOT match (returns empty):
 *   ls -la                               → []
 *
 * Exported for unit tests; not part of the public API of this module.
 */
export function extractBashRedirectionTargets(command: string): string[] {
  const out: string[] = [];
  // Matches `>` or `>>` not preceded by `2` or `&` (to skip 2>&1 style fd
  // duplication) followed by optional whitespace and a bare word / quoted
  // string. The bare-word form excludes shell separators (`;`, `|`, `&`) so
  // `echo a > one.md; echo b >> two.md` captures two distinct targets
  // instead of swallowing the separator. Pathological shell is not our
  // target — these are heuristics for overlap detection, not a parser.
  const redirRe = /(?<![2&])>>?\s*("([^"]+)"|'([^']+)'|([^\s;|&]+))/g;
  let m = redirRe.exec(command);
  while (m !== null) {
    let target = m[2] ?? m[3] ?? m[4];
    // Strip trailing shell terminators (;, &, |, `) that greedy \S+ matched.
    target = target.replace(/[;&|`]+$/, "");
    if (target && target.length > 0) out.push(target);
    m = redirRe.exec(command);
  }

  // `tee <file>` — `tee -a <file>` also matches. Skip `tee` options like
  // `-a`, `--append`, `-i`, `--ignore-interrupts`, `--`.
  const teeRe = /\btee\s+((?:-\w+\s+|--\w+\s+)*)(\S+)/g;
  let t = teeRe.exec(command);
  while (t !== null) {
    // Strip matching outer quotes off the target, if any.
    let target = t[2];
    const q = target[0];
    if ((q === '"' || q === "'") && target.endsWith(q)) {
      target = target.slice(1, -1);
    }
    if (target.length > 0) out.push(target);
    t = teeRe.exec(command);
  }

  return out;
}

/**
 * SessionManager read surface the overlap injector actually needs. Accepting
 * a structural type (not the full class) keeps tests lightweight.
 */
export interface SessionEntriesSource {
  getEntries(): SessionEntry[];
}

/**
 * Union all file paths touched by assistant messages in the source.
 * Deduped via Set. Returns an empty Set for a source that hasn't
 * mutated any files (including fresh sessions / empty slices).
 *
 * Walks `getEntries()` rather than `getBranch()`: the per-completion
 * overlap mechanism (R7-PERF-2) cares about "has the parent written
 * X since the previous distill completion?" Caller bounds the walk by
 * passing a slice-of-entries source (e.g.
 * `{ getEntries: () => allEntries.slice(cursor) }`).
 */
export function getSessionTouchedFiles(sm: SessionEntriesSource): Set<string> {
  const out = new Set<string>();
  for (const entry of sm.getEntries()) {
    if (entry.type !== "message") continue;
    const msg = (entry as { message?: AssistantMessageShape }).message;
    if (!msg || msg.role !== "assistant") continue;
    for (const p of extractFileOpsFromMessage(msg)) {
      out.add(p);
    }
  }
  return out;
}
