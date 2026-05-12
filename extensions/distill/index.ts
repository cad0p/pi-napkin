import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Napkin } from "@cad0p/napkin";
import type {
  CustomEntry,
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  countTrackedFiles,
  ensureVaultReadyForAutoDistill,
} from "./auto-setup";
import {
  type ActiveDistill,
  cleanupDistillWorkspace,
  cleanupStaleWorktrees,
  DistillError,
  diffWorktreeSinceStart,
  getActiveDistills,
  getDistillState,
  spawnDistillInWorktree,
} from "./distill-workspace";
import { DISTILL_WRAPPER_LEGACY_SCRIPT } from "./scripts-paths";
import { getSessionTouchedFiles } from "./session-touched-files";
import { shouldDistillOnShutdown } from "./should-distill-on-shutdown";

export interface DistillConfig {
  enabled: boolean;
  intervalMinutes: number;
  /**
   * Whether to run a final distill at session shutdown. Defaults to `true`.
   *
   * The shutdown handler consults this via `shouldDistillOnShutdown` — if
   * false, shutdown distill is skipped even when other guards would allow it.
   * Does not affect interval distill or manual `/distill`.
   */
  onShutdown: boolean;
  model?: { provider: string; id: string };
}

export interface VaultConfig {
  showStatus: boolean;
  distill: DistillConfig;
}

/**
 * Hard cap on how long we'll poll for a distill subprocess to complete
 * before declaring it timed out and abandoning the worktree / tmp target.
 *
 * 10 minutes is the production default. Tests can override this via
 * `NAPKIN_DISTILL_MAX_DURATION_MS_OVERRIDE` so the timeout branch is
 * exercisable without waiting 10 real minutes. The override is read each
 * time the value is needed, so a test can set it before registering the
 * extension and clear it in `afterEach`.
 */
export function getMaxDistillDurationMs(): number {
  const override = process.env.NAPKIN_DISTILL_MAX_DURATION_MS_OVERRIDE;
  if (override) {
    const n = Number.parseInt(override, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 10 * 60 * 1000; // 10 minutes
}

/**
 * Custom entry type used to persist `/distill-auto-this-session` state into the
 * session file. CustomEntry (unlike CustomMessageEntry) does not participate in
 * LLM context, so we can write freely without affecting the agent.
 *
 * Schema is append-only: the `suppressed: boolean` key must remain stable so
 * new-version writers aren't shadowed by older valid entries.
 */
const SESSION_STATE_CUSTOM_TYPE = "napkin-distill-session-state";

interface SessionPauseState {
  suppressed: boolean;
}

/**
 * Extension handlers receive a `ReadonlySessionManager`, but the runtime object
 * is a full `SessionManager` with write methods. Napkin-context already relies
 * on this (calls `appendCustomMessageEntry` directly); we do the same.
 */
interface WritableSessionShape {
  appendCustomEntry(customType: string, data?: unknown): string;
}

/**
 * Read the latest persisted pause state from the current session branch.
 *
 * Uses `getBranch()` (canonical for state restoration — see todo, summarize,
 * handoff, qna examples) so entries on abandoned branches don't leak into the
 * live branch. Stops at the first matching `customType` even on malformed
 * data to protect new-version writers from being shadowed by older entries.
 */
function readPersistedSuppressed(sm: {
  getBranch(fromId?: string): SessionEntry[];
}): boolean {
  const branch = sm.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "custom") continue;
    const custom = entry as CustomEntry<SessionPauseState>;
    if (custom.customType !== SESSION_STATE_CUSTOM_TYPE) continue;
    if (custom.data && typeof custom.data.suppressed === "boolean") {
      return custom.data.suppressed;
    }
    return false;
  }
  return false;
}

/** Append the current pause state as a CustomEntry in the session. */
function persistSuppressed(sm: unknown, suppressed: boolean): void {
  (sm as WritableSessionShape).appendCustomEntry(SESSION_STATE_CUSTOM_TYPE, {
    suppressed,
  } satisfies SessionPauseState);
}

export const DEFAULT_DISTILL: DistillConfig = {
  enabled: false,
  intervalMinutes: 60,
  onShutdown: true,
};

export function loadVaultConfig(vaultPath: string): VaultConfig {
  const configPath = path.join(vaultPath, "config.json");
  if (!fs.existsSync(configPath)) {
    return { showStatus: true, distill: DEFAULT_DISTILL };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return {
      showStatus: raw.showStatus !== false,
      distill: { ...DEFAULT_DISTILL, ...(raw.distill || {}) },
    };
  } catch {
    return { showStatus: true, distill: DEFAULT_DISTILL };
  }
}

const DISTILL_PROMPT = `Distill this conversation into the napkin vault.

1. \`napkin overview\` — learn the vault structure and what exists. Read \`_about.md\` files to understand what each folder is for. These are short folder descriptions (1-2 paragraphs) explaining what kinds of notes belong there — see existing ones for style.
2. \`napkin template list\` and \`napkin template read\` — learn the note formats.
3. Identify what's worth capturing. The vault structure and templates tell you what kinds of notes belong.
4. For each note:
   a. \`napkin search\` for the topic — if a note already covers it, \`napkin append\` instead of creating a duplicate
   b. Create new notes with \`napkin create\`, following the template format; use the relevant folder path
   c. Add \`[[wikilinks]]\` to related notes
5. Append a brief summary of key activities and decisions to today's daily note in the relevant namespace (e.g. \`{namespace}/daily/YYYY-MM-DD.md\`). Follow existing patterns. Create it if it doesn't exist.

Frontmatter convention: when you create a note that replaces an older one, add
\`supersedes: ["path/to/old/note.md"]\` to its frontmatter. A future janitor will
archive the superseded note. Leave the field empty or omit it for notes that
stand alone.

Be selective. Only capture knowledge useful to someone working on this project later. Skip meta-discussion, tool output, and chatter.`;

/**
 * Spawn a detached pi distill process that survives parent exit.
 * The shell wrapper cleans up the temp dir when pi finishes.
 * Returns the temp dir path (used as a completion marker — when it disappears, distill is done).
 *
 * All arguments flow through argv (not `sh -c`) so there's zero shell-string
 * interpolation in the spawn pipeline. The wrapper script
 * (`distill-wrapper-legacy.sh`) runs pi and removes the temp dir, matching
 * the worktree spawn path style.
 */
export function spawnDistill(
  sessionFile: string,
  cwd: string,
  config: DistillConfig,
  spawnFn: typeof spawn = spawn,
): string | null {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-distill-"));

  try {
    const forkedSm = SessionManager.forkFrom(sessionFile, cwd, tmpDir);
    const forkedFile = forkedSm.getSessionFile();
    if (!forkedFile) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return null;
    }

    // Positional args for the wrapper: [sessionFile, tmpDir, prompt, model?].
    // Empty model string tells the wrapper to skip the --model flag.
    const modelStr = config.model
      ? `${config.model.provider}/${config.model.id}`
      : "";
    const wrapperArgs = [
      DISTILL_WRAPPER_LEGACY_SCRIPT,
      forkedFile,
      tmpDir,
      DISTILL_PROMPT,
      modelStr,
    ];

    // Invoke via `bash` (not `sh`): the legacy wrapper's shebang is
    // `#!/usr/bin/env bash` and it uses bash-specific syntax (arrays
    // `pi_args=(...)`). On Ubuntu, `/bin/sh` is `dash` which parse-errors
    // on bash syntax.
    const proc = spawnFn("bash", wrapperArgs, {
      cwd,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, NAPKIN_DISTILL_NO_RECURSE: "1" },
    });
    proc.unref();

    return tmpDir;
  } catch {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let countdownHandle: ReturnType<typeof setInterval> | null = null;
  let pollHandle: ReturnType<typeof setInterval> | null = null;
  let lastDistillTimestamp = Date.now();
  let lastSessionSize = 0;
  /**
   * Byte size of the session file at the moment the most recent distill
   * subprocess was successfully spawned. Separate from `lastSessionSize`
   * (which updates on completion): this tracks SPAWN so that a shutdown
   * firing between spawn-and-complete dedupes against the in-flight distill
   * without having to wait for it to finish.
   *
   * Read by `shouldDistillOnShutdown` in the session_shutdown handler
   * (guard #8). Written by `runDistill`, `runAutoDistill`, and the shutdown
   * handler itself (after a successful shutdown spawn).
   */
  let lastSpawnedSize = 0;
  let isRunning = false;
  // Session-scoped suppression of the automatic distill timer.
  // Toggled via `/distill-auto-this-session` — does NOT affect manual `/distill`.
  let autoDistillSuppressed = false;

  // Refs captured from session_start so `/distill-auto-this-session` can refresh
  // the status bar immediately without waiting for the next countdown tick.
  //
  // `ExtensionUIContext` is pi's public UI surface (setStatus, theme, …). We keep
  // the whole thing instead of a narrow subset so future status-bar tweaks don't
  // need to widen the type — and so TS catches method renames at the pi boundary.
  type DistillUIRef = {
    hasUI: boolean;
    ui: ExtensionUIContext;
    showStatus: boolean;
    intervalMs: number;
  };
  let uiRef: DistillUIRef | null = null;

  function renderIdleStatus(): void {
    if (!uiRef?.hasUI || !uiRef.showStatus) return;
    // While a distill is in flight the poll loop owns the status bar; leave it alone.
    if (isRunning) return;
    const theme = uiRef.ui.theme;
    if (autoDistillSuppressed) {
      uiRef.ui.setStatus(
        "napkin-distill",
        theme.fg("dim", "distill: off (session)"),
      );
      return;
    }
    uiRef.ui.setStatus(
      "napkin-distill",
      theme.fg("dim", `distill: ${formatRemaining()}`),
    );
  }

  /** Formatted time until the next scheduled auto-distill, or `"—"` if unknown. */
  function formatRemaining(): string {
    if (!uiRef) return "—";
    const remaining = Math.max(
      0,
      uiRef.intervalMs - (Date.now() - lastDistillTimestamp),
    );
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    return mins > 0
      ? `${mins}m${secs.toString().padStart(2, "0")}s`
      : `${secs}s`;
  }

  pi.on("session_start", async (event, ctx) => {
    // Reset to default before any early-return paths below; the persisted state
    // (if any) is re-read further down when distill is enabled for the session.
    autoDistillSuppressed = false;

    let napkinVault: { configPath: string; contentPath: string };
    try {
      napkinVault = new Napkin(ctx.cwd).vault;
    } catch {
      return;
    }
    const vaultConfigPath = napkinVault.configPath;

    const { showStatus, distill: config } = loadVaultConfig(vaultConfigPath);
    if (!config.enabled) {
      if (ctx.hasUI && showStatus) {
        ctx.ui.setStatus(
          "napkin-distill",
          ctx.ui.theme.fg("dim", "distill: off"),
        );
      }
      return;
    }

    // Skip if this is a distill subprocess
    if (process.env.NAPKIN_DISTILL_NO_RECURSE) return;

    // Auto-init git + scaffold .gitignore/.gitattributes so subsequent
    // worktree operations have the invariants they need. Idempotent and
    // non-throwing — on failure we notify once and disable auto-distill for
    // this session rather than retrying on every interval fire.
    //
    // Scope: operate on `napkinVault.contentPath` — the vault root as
    // napkin resolves it from cwd. This is cwd-independent: when pi is
    // launched outside the vault (e.g. in another project directory),
    // findVault still resolves to the user's real vault via a global
    // config fallback at `~/.config/napkin/config.json`. Using `ctx.cwd`
    // here would scaffold `.git` in the WRONG directory and leave the
    // real vault untouched — breaking both auto-init and later worktree
    // operations that (now also correctly) target the vault.
    //
    // `setupFailed` is the load-bearing signal for the suppression logic
    // below: once setup has failed, we MUST NOT re-read the persisted
    // suppression state, because a `false` there would re-enable
    // auto-distill on a vault that isn't actually usable.
    const vaultContentPath = napkinVault.contentPath;
    let setupFailed = false;
    try {
      const setup = ensureVaultReadyForAutoDistill({
        contentPath: vaultContentPath,
      });
      if (setup.error) {
        setupFailed = true;
        if (ctx.hasUI) {
          if (setup.conflict) {
            // G7: existing `.gitattributes` already claims `*.md merge=<X>`.
            // We refuse to scaffold so we don't silently override the
            // user's chosen driver via last-match-wins. Explain the
            // options clearly — auto-distill is off for this session, but
            // manual /distill still works.
            ctx.ui.notify(
              [
                `Auto-distill setup blocked: your .gitattributes already has a merge rule for *.md ('${setup.conflict.rule}').`,
                "Auto-distill needs its own driver to handle concurrent distill merges safely. To enable:",
                `  - Remove the conflicting rule from ${setup.conflict.file}, OR`,
                "  - Set distill.onShutdown: false in vault config.json to disable auto-distill on shutdown",
                "Manual /distill still works regardless.",
              ].join("\n"),
              "error",
            );
          } else {
            ctx.ui.notify(
              `Auto-distill setup failed: ${setup.error}. Disabling auto-distill for this session.`,
              "error",
            );
          }
        }
      } else if (setup.initialized) {
        const tracked = countTrackedFiles(vaultContentPath);
        const files = tracked >= 0 ? tracked : setup.scaffolded.length;
        if (ctx.hasUI) {
          ctx.ui.notify(
            [
              "Initialized git repo in your vault for auto-distill.",
              `Commit: 'napkin: initial vault commit (auto-distill setup)'`,
              `Files tracked: ${files}`,
              `To undo: rm -rf ${path.join(vaultContentPath, ".git")} (removes history, keeps files)`,
              "To opt out: set distill.enabled: false in vault config.json",
            ].join("\n"),
            "info",
          );
        }
      } else if (setup.scaffolded.length > 0) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Added ${setup.scaffolded.join(", ")} for auto-distill.`,
            "info",
          );
        }
      }
    } catch (err) {
      // Truly unexpected (ensureVaultReadyForAutoDistill is supposed to not
      // throw). Log + continue, worst case later operations fail gracefully.
      console.error("[napkin-distill] auto-setup threw:", err);
    }

    // Sweep out stale distill worktrees left behind by crashed pi sessions.
    // Idempotent, best-effort — never throws, never blocks session_start.
    try {
      cleanupStaleWorktrees({ contentPath: vaultContentPath });
    } catch {
      // swallow — cleanup is non-critical to session lifecycle
    }

    // Restore the per-session pause state from the session file so that
    // resuming a session retains the `/distill-auto-this-session` setting.
    //
    // BUT: when setup failed above, we must keep the safety flag ON. The
    // persisted value reflects USER intent (opted out for this session);
    // setup failure is a VAULT-level problem that should override user
    // intent for this session only — next session will re-try setup.
    if (setupFailed) {
      autoDistillSuppressed = true;
    } else {
      autoDistillSuppressed = readPersistedSuppressed(ctx.sessionManager);
    }

    lastDistillTimestamp = Date.now();
    const intervalMs = config.intervalMinutes * 60 * 1000;

    uiRef = { hasUI: ctx.hasUI, ui: ctx.ui, showStatus, intervalMs };

    // Paint initial state immediately so a resumed paused session doesn't
    // briefly show the countdown before the first tick.
    renderIdleStatus();

    // On resume, if the session is off, surface it once via notify — the
    // status bar is easy to miss after a long gap between sessions. Fire for
    // all reasons except `"new"` (fresh sessions never match — branch is empty
    // — but explicitly exclude to keep the intent obvious) and `"reload"`
    // (would fire on every in-session config reload).
    if (
      ctx.hasUI &&
      autoDistillSuppressed &&
      (event.reason === "resume" ||
        event.reason === "fork" ||
        event.reason === "startup")
    ) {
      ctx.ui.notify(
        "Auto-distill is off for this session. Run /distill-auto-this-session on to turn on.",
        "info",
      );
    }

    if (ctx.hasUI && showStatus) {
      countdownHandle = setInterval(() => {
        // `renderIdleStatus` self-guards against in-flight distills; when off
        // it paints `distill: off (session)` (pi dedupes identical status strings).
        renderIdleStatus();
      }, 1000);
    }

    intervalHandle = setInterval(() => {
      if (autoDistillSuppressed) return;
      runAutoDistill(ctx);
    }, intervalMs);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (countdownHandle) {
      clearInterval(countdownHandle);
      countdownHandle = null;
    }
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
    if (pollHandle) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
    // Reset `isRunning` so a distill that was mid-flight at shutdown doesn't
    // stick as `true` across an in-process session switch and suppress the
    // next session's status-bar rendering.
    isRunning = false;

    // ------- Final shutdown distill (Phase B Item 8) -------------------------
    //
    // Spawn one last auto-distill if the session has content that hasn't been
    // captured yet. Guards live in `shouldDistillOnShutdown` — this block
    // only assembles inputs and calls it. Any failure logs and falls through;
    // shutdown must never block.
    //
    // Intentionally AFTER the timer cleanup above: clearing intervalHandle
    // first prevents the rare race where the interval fires during shutdown
    // and we end up with two concurrent spawns on the same content.
    //
    // Config is re-read via loadVaultConfig rather than captured from
    // session_start — handler scope keeps closures small, and the cost of
    // one extra JSON parse at shutdown is negligible.
    try {
      let vaultInfo: { configPath: string; contentPath: string } | null = null;
      try {
        vaultInfo = new Napkin(ctx.cwd).vault;
      } catch {
        // No vault resolvable — skip spawn, proceed to final resets.
      }
      if (vaultInfo) {
        const { distill: config } = loadVaultConfig(vaultInfo.configPath);
        const sessionFile = ctx.sessionManager.getSessionFile?.();
        const currentSize =
          sessionFile && fs.existsSync(sessionFile)
            ? fs.statSync(sessionFile).size
            : 0;

        if (
          shouldDistillOnShutdown(
            event,
            config,
            autoDistillSuppressed,
            sessionFile,
            currentSize,
            lastSpawnedSize,
            lastSessionSize,
          )
        ) {
          // Guard: we require git for the worktree path, rooted at the
          // vault's content directory (where auto-init placed `.git`).
          // Using `ctx.cwd` here would miss the repo when pi was launched
          // outside the vault — the very bug this change fixes.
          if (
            fs.existsSync(path.join(vaultInfo.contentPath, ".git")) &&
            sessionFile
          ) {
            const modelStr = config.model
              ? `${config.model.provider}/${config.model.id}`
              : undefined;
            spawnDistillInWorktree({
              vault: vaultInfo.contentPath,
              sessionFile,
              prompt: DISTILL_PROMPT,
              model: modelStr,
            });
            // Mark this size as "spawned" so if the parent re-enters shutdown
            // (unlikely but possible with session switch), we don't duplicate.
            lastSpawnedSize = currentSize;
          }
        }
      }
    } catch (err) {
      // Never block shutdown. stderr logging only — no UI at this point.
      console.error("[napkin-distill] shutdown spawn failed:", err);
    }

    uiRef = null;
    // No need to kill anything — detached processes survive on their own
  });

  // ---------------------------------------------------------------------------
  // before_agent_start: overlap injection
  //
  // Fires once per user prompt, before the agent loop starts. When the
  // current session has written to vault files that a live background
  // distill is also editing, we append a short notice to `systemPrompt`
  // so the agent knows its recent writes may be clobbered / merged when
  // the distill completes.
  //
  // Using `systemPrompt` (not `message`) is deliberate:
  //   - Not persisted — 0 tokens when the next turn has no overlap.
  //   - Doesn't grow the session file.
  //   - Cache-friendly: the notice lives at the END of the system prompt,
  //     so the stable prefix still hits provider caches.
  //
  // Session-touched files are extracted by `getSessionTouchedFiles`, a
  // reimplementation of pi's internal `extractFileOpsFromMessage`
  //   // Reimplemented from pi's internal extractFileOpsFromMessage
  //   // Original: @earendil-works/pi-coding-agent ^0.74.0
  //   // dist/core/compaction/utils.js — extractFileOpsFromMessage / computeFileLists
  //   // Not exported; sync with pi upstream when tool catalog changes.
  // Distill-touched files come from `git diff --name-only <startSha>..HEAD`
  // inside each live distill worktree (falls back to `git status --porcelain`
  // when startSha is missing from legacy meta.json).
  //
  // All failures collapse to "no overlap detected" — this hook must never
  // block the agent turn.
  pi.on("before_agent_start", async (event, ctx) => {
    // Skip injection inside the distill subprocess itself — it's the one
    // writing the files, talking to itself about overlaps would be noise.
    if (process.env.NAPKIN_DISTILL_NO_RECURSE) return;

    let vaultPath: string;
    try {
      // Resolve the vault's content root — auto-setup placed `.git` and
      // worktrees there. `contentPath` is cwd-independent: it points at
      // the user's actual vault even when pi is launched elsewhere.
      vaultPath = new Napkin(ctx.cwd).vault.contentPath;
    } catch {
      return;
    }

    let sessionTouched: Set<string>;
    try {
      sessionTouched = getSessionTouchedFiles(ctx.sessionManager);
    } catch {
      return;
    }
    if (sessionTouched.size === 0) return;

    let actives: ActiveDistill[];
    try {
      actives = getActiveDistills({ contentPath: vaultPath }).filter(
        (a) => a.alive,
      );
    } catch {
      return;
    }
    if (actives.length === 0) return;

    // Union of all paths the live distills have changed since their
    // startSha. Each entry is a path relative to the worktree root
    // (== vault root), e.g. `notes/foo.md`.
    const distillTouched = new Set<string>();
    for (const a of actives) {
      try {
        for (const f of diffWorktreeSinceStart({
          worktreePath: a.worktreePath,
          startSha: a.startSha,
        })) {
          distillTouched.add(f);
        }
      } catch {
        // swallow — one worktree failing doesn't stop the others
      }
    }
    if (distillTouched.size === 0) return;

    const overlap = intersectFiles(sessionTouched, distillTouched);
    if (overlap.length === 0) return;

    return { systemPrompt: event.systemPrompt + formatOverlapNotice(overlap) };
  });

  /**
   * Ctx shape shared by the two run-distill paths. Kept as a `Pick` of
   * pi's real `ExtensionContext` so the four fields we care about stay
   * in sync with pi at the type level (any rename upstream surfaces as
   * a compile error here rather than silently widening to `any`).
   */
  type RunCtx = Pick<
    ExtensionContext,
    "sessionManager" | "hasUI" | "ui" | "cwd"
  >;

  /**
   * Strategy bundle for the shared runner. Each caller (legacy or worktree)
   * supplies a preflight check, a spawn invocation, a poll-completion
   * target, and a timeout cleanup step. Everything else (config load,
   * size dedup, status-bar painting, poll loop wiring, completion
   * bookkeeping) is common.
   *
   * All strategy callbacks receive `vaultContentPath` — the vault's content
   * root as resolved by napkin, NOT `ctx.cwd`. This is what makes the
   * whole auto-distill pipeline cwd-independent: worktrees, git, and the
   * legacy spawn all target the user's actual vault even when pi is
   * launched from another directory (napkin's findVault walks up from
   * `ctx.cwd` and falls back to the global config).
   */
  interface DistillStrategy {
    /**
     * Optional pre-flight check. Return `{ ok: false, errorStatus }` to
     * short-circuit with a status-bar message, or `{ ok: true }` to
     * continue. Invoked after config load + size dedup, before spawn.
     */
    preflight?: (args: {
      ctx: RunCtx;
      vaultContentPath: string;
      theme: unknown;
    }) => { ok: true } | { ok: false; errorStatus?: string };
    /**
     * Spawn the distill subprocess. Returns `{ target }` on success — a
     * filesystem path whose disappearance marks completion. Returns null
     * to signal a spawn failure (caller paints an error in the status
     * bar).
     */
    spawnFn: (args: {
      ctx: RunCtx;
      vaultContentPath: string;
      sessionFile: string;
      config: DistillConfig;
    }) => {
      target: string;
      cleanup: () => void;
      spawnErrorMsg?: string;
    } | null;
  }

  /**
   * Shared runner for the two distill paths. Encodes the full lifecycle:
   *   1. Early-return if isRunning.
   *   2. Resolve vault config; bail silently if cwd isn't a vault.
   *   3. Read session file; size-dedup against lastSessionSize.
   *   4. Run strategy.preflight; short-circuit on failure.
   *   5. strategy.spawn; on failure paint error status.
   *   6. Bookkeeping: lastSpawnedSize = currentSize, isRunning = true,
   *      start polling for target disappearance.
   *   7. On completion: update lastSessionSize + lastDistillTimestamp, paint
   *      success status, notify.
   *   8. On timeout: invoke strategy's cleanup callback and paint error.
   */
  function runDistillWith(ctx: RunCtx, strategy: DistillStrategy): void {
    if (isRunning) return;

    let vaultInfo: { configPath: string; contentPath: string };
    try {
      vaultInfo = new Napkin(ctx.cwd).vault;
    } catch {
      return;
    }
    const vaultContentPath = vaultInfo.contentPath;

    const { showStatus, distill: config } = loadVaultConfig(
      vaultInfo.configPath,
    );
    const sessionFile = ctx.sessionManager.getSessionFile?.();
    if (!sessionFile) return;

    // Skip if session hasn't changed since last distill.
    const currentSize = fs.existsSync(sessionFile)
      ? fs.statSync(sessionFile).size
      : 0;
    if (currentSize > 0 && currentSize === lastSessionSize) {
      lastDistillTimestamp = Date.now();
      return;
    }

    const theme = ctx.hasUI ? ctx.ui.theme : null;

    // Strategy-specific pre-flight.
    if (strategy.preflight) {
      const pre = strategy.preflight({ ctx, vaultContentPath, theme });
      if (!pre.ok) {
        if (ctx.hasUI && theme && showStatus && pre.errorStatus) {
          ctx.ui.setStatus(
            "napkin-distill",
            theme.fg("error", "✗") + theme.fg("dim", ` ${pre.errorStatus}`),
          );
        }
        return;
      }
    }

    const spawned = strategy.spawnFn({
      ctx,
      vaultContentPath,
      sessionFile,
      config,
    });
    if (!spawned) {
      if (ctx.hasUI && theme && showStatus) {
        ctx.ui.setStatus(
          "napkin-distill",
          theme.fg("error", "✗") + theme.fg("dim", " distill: spawn failed"),
        );
      }
      return;
    }
    const { target, cleanup: spawnCleanup } = spawned;

    // Record the size we spawned on so a shutdown firing between here and
    // completion dedupes against the in-flight distill.
    lastSpawnedSize = currentSize;

    isRunning = true;
    const startTime = Date.now();

    if (ctx.hasUI && theme && showStatus) {
      ctx.ui.setStatus(
        "napkin-distill",
        theme.fg("accent", "●") + theme.fg("dim", " distill"),
      );
    }

    pollHandle = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const timedOut = Date.now() - startTime > getMaxDistillDurationMs();

      if (fs.existsSync(target) && !timedOut) {
        if (ctx.hasUI && theme && showStatus) {
          ctx.ui.setStatus(
            "napkin-distill",
            theme.fg("accent", "●") + theme.fg("dim", ` distill ${elapsed}s`),
          );
        }
        return;
      }

      if (pollHandle) {
        clearInterval(pollHandle);
        pollHandle = null;
      }
      isRunning = false;

      if (timedOut) {
        try {
          spawnCleanup();
        } catch {
          // ignore — best-effort cleanup on timeout
        }
        if (ctx.hasUI && theme) {
          if (showStatus) {
            ctx.ui.setStatus(
              "napkin-distill",
              theme.fg("error", "✗") + theme.fg("dim", " distill: timeout"),
            );
          }
          ctx.ui.notify(
            `Distillation timed out (${Math.round(getMaxDistillDurationMs() / 60000)}m)`,
            "error",
          );
        }
        return;
      }

      lastDistillTimestamp = Date.now();
      lastSessionSize = currentSize;

      if (ctx.hasUI && theme) {
        if (showStatus) {
          ctx.ui.setStatus(
            "napkin-distill",
            theme.fg("success", "✓") + theme.fg("dim", ` distill ${elapsed}s`),
          );
        }
        ctx.ui.notify(`Distillation complete (${elapsed}s)`, "info");
      }
    }, 2000);
  }

  function runDistill(ctx: RunCtx) {
    // Manual `/distill`: use the worktree path when git is available (same
    // concurrency safety as auto-distill), fall back to the legacy
    // git-less tmpdir path only when the vault has no `.git/`.
    //
    // Why not always worktree? Some users keep their vault outside git
    // on purpose (mobile-only Obsidian, ephemeral scratch vaults, etc.)
    // and should still be able to run `/distill` manually without
    // pi-napkin refusing. The detection is cheap and the fallback is
    // the original git-less path, preserved unchanged.
    //
    // Cross-session concurrency caveat: two concurrent manual /distills
    // on a git-less vault race on napkin writes because the legacy path
    // has no worktree isolation. `isRunning` blocks a second /distill
    // in the same pi session, but not across sessions. If this becomes
    // a problem, the fix is to add a small flock around the legacy
    // spawn; for now the design matches the pre-worktree behavior.
    runDistillWith(ctx, {
      spawnFn: (args) => {
        if (fs.existsSync(path.join(args.vaultContentPath, ".git"))) {
          return worktreeSpawnFn(args);
        }
        return legacySpawnFn(args);
      },
    });
  }

  /**
   * Worktree-backed auto-distill path — used by the interval timer and the
   * shutdown handler (Item 8). Concurrency-safe via per-distill git
   * worktrees: each call spawns a detached wrapper that operates on its
   * own branch, so overlapping distills (interval + shutdown, or multiple
   * pi sessions on the same vault) merge serially on main via the LLM
   * merge driver.
   */
  function runAutoDistill(ctx: RunCtx) {
    runDistillWith(ctx, {
      preflight: ({ vaultContentPath }) => {
        // Auto-distill requires the vault to be a git repo. Phase C1
        // auto-init wires this at session_start; we surface a one-shot
        // status-bar hint here for belt-and-braces.
        if (!fs.existsSync(path.join(vaultContentPath, ".git"))) {
          return { ok: false, errorStatus: "distill: needs git" };
        }
        return { ok: true };
      },
      spawnFn: worktreeSpawnFn,
    });
  }

  /**
   * Legacy tmpdir spawn strategy. Forks the session under `$TMPDIR` and
   * runs `pi -p` detached; cleanup is a plain `rmSync`. No git, no
   * concurrency coordination. Only used by manual `/distill` as a
   * fallback for vaults without `.git/`.
   */
  function legacySpawnFn(args: {
    ctx: RunCtx;
    vaultContentPath: string;
    sessionFile: string;
    config: DistillConfig;
  }): { target: string; cleanup: () => void } | null {
    const { vaultContentPath, sessionFile, config } = args;
    const tmpDir = spawnDistill(sessionFile, vaultContentPath, config);
    if (!tmpDir) return null;
    return {
      target: tmpDir,
      cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
    };
  }

  /**
   * Worktree spawn strategy. Creates a per-distill git worktree off the
   * vault's default branch, runs the detached wrapper that merges back
   * via the LLM merge driver + squash. Concurrency-safe across sessions.
   *
   * Shared by `runDistill` (when git is available) and `runAutoDistill`.
   * A `DistillError` from the workspace layer (branch collision, fork
   * failure, invalid HEAD, merge driver missing) is caught and rendered
   * as an error status; the shared runner treats a null return as a
   * spawn failure and skips the poll loop.
   */
  function worktreeSpawnFn(args: {
    ctx: RunCtx;
    vaultContentPath: string;
    sessionFile: string;
    config: DistillConfig;
  }): { target: string; cleanup: () => void } | null {
    const { ctx: c, vaultContentPath, sessionFile, config } = args;
    try {
      const modelStr = config.model
        ? `${config.model.provider}/${config.model.id}`
        : undefined;
      const result = spawnDistillInWorktree({
        vault: vaultContentPath,
        sessionFile,
        prompt: DISTILL_PROMPT,
        model: modelStr,
      });
      return {
        target: result.workspace.worktreePath,
        cleanup: () => {
          try {
            cleanupDistillWorkspace(vaultContentPath, result.workspace);
          } catch {
            // ignore
          }
        },
      };
    } catch (err) {
      const theme = c.hasUI ? c.ui.theme : null;
      const { showStatus } = loadVaultConfig(
        new Napkin(c.cwd).vault.configPath,
      );
      if (c.hasUI && theme && showStatus) {
        const msg =
          err instanceof DistillError
            ? "distill: setup failed"
            : "distill: spawn failed";
        c.ui.setStatus(
          "napkin-distill",
          theme.fg("error", "✗") + theme.fg("dim", ` ${msg}`),
        );
      }
      return null;
    }
  }

  pi.registerCommand("distill", {
    description: "Distill conversation knowledge into the vault",
    handler: async (_args, ctx) => {
      if (isRunning) {
        if (ctx.hasUI) ctx.ui.notify("Distill already running", "warning");
        return;
      }
      lastSessionSize = 0; // bypass size check
      runDistill(ctx);
    },
  });

  pi.registerCommand("distill-auto-this-session", {
    description: "Pause/resume auto-distill for this session (on|off|status)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const needle = prefix.toLowerCase();
      const values = ["on", "off", "status"];
      const items = values
        .filter((v) => v.startsWith(needle))
        .map((v) => ({ value: v, label: v }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      // Detect when distill is disabled in the vault config so we can warn that
      // toggling the session flag has no effect.
      let vaultDistillEnabled = false;
      try {
        const vaultConfigPath = new Napkin(ctx.cwd).vault.configPath;
        vaultDistillEnabled = loadVaultConfig(vaultConfigPath).distill.enabled;
      } catch {
        // No vault — treat as disabled at vault level.
      }

      const vaultDisabledHint =
        "distill is disabled in vault config — set distill.enabled=true in .napkin/config.json";

      function describeState(suppressed: boolean): string {
        if (suppressed) return "Auto-distill is off for this session";
        return `Auto-distill is on for this session (next run in ${formatRemaining()})`;
      }

      let nextSuppressed: boolean;
      switch (arg) {
        case "":
          nextSuppressed = !autoDistillSuppressed;
          break;
        case "on":
          nextSuppressed = false;
          break;
        case "off":
          nextSuppressed = true;
          break;
        case "status": {
          if (!ctx.hasUI) return;
          if (!vaultDistillEnabled) {
            ctx.ui.notify(vaultDisabledHint, "warning");
            return;
          }
          ctx.ui.notify(describeState(autoDistillSuppressed), "info");
          return;
        }
        default:
          if (ctx.hasUI) {
            ctx.ui.notify(
              "Usage: /distill-auto-this-session [on|off|status]",
              "warning",
            );
          }
          return;
      }

      const wasSuppressed = autoDistillSuppressed;
      autoDistillSuppressed = nextSuppressed;

      // Persist state changes to the session file so the setting survives pi
      // restart and session resume. No-ops don't touch the session — otherwise
      // repeated invocations would bloat the file with identical entries.
      if (wasSuppressed !== nextSuppressed) {
        persistSuppressed(ctx.sessionManager, nextSuppressed);
      }

      // When re-enabling, reset the timer so the next run respects a full
      // interval instead of firing immediately if we were already past it.
      if (wasSuppressed && !nextSuppressed) {
        lastDistillTimestamp = Date.now();
      }

      renderIdleStatus();

      if (!ctx.hasUI) return;

      if (!vaultDistillEnabled) {
        ctx.ui.notify(vaultDisabledHint, "warning");
        return;
      }

      if (wasSuppressed === nextSuppressed) {
        ctx.ui.notify(describeState(nextSuppressed), "info");
        return;
      }

      if (nextSuppressed) {
        ctx.ui.notify("Auto-distill off for this session", "info");
      } else {
        ctx.ui.notify(
          `Auto-distill on for this session (next run in ${formatRemaining()})`,
          "info",
        );
      }
    },
  });

  // ---------------------------------------------------------------------------
  // /distill-status and napkin_distill_status
  //
  // Shared state: both surfaces read the exact same data (active worktrees +
  // unmerged branches) via module-level `collectDistillStatus`. The command
  // formats it for humans via `formatDistillStatus`; the tool returns the
  // JSON shape for the agent via `distillStatusToJson`. The formatters are
  // module-level + exported so tests can verify their output without wiring
  // a full mock `ExtensionAPI`.
  // ---------------------------------------------------------------------------

  /**
   * Resolve the main vault path from a command/tool `ctx`. Returns null when
   * no vault can be resolved (ctx.cwd isn't inside a napkin vault) — callers
   * surface a user-facing message in that case.
   */
  function resolveVaultPath(cwd: string): string | null {
    try {
      return new Napkin(cwd).vault.contentPath;
    } catch {
      return null;
    }
  }

  pi.registerCommand("distill-status", {
    description: "Show active auto-distill processes for the current vault",
    handler: async (_args, ctx) => {
      const vaultPath = resolveVaultPath(ctx.cwd);
      if (!vaultPath) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "No napkin vault resolved from current directory.",
            "warning",
          );
        }
        return;
      }

      const { active, unmerged } = collectDistillStatus(vaultPath);
      const msg = formatDistillStatus(active, unmerged);

      if (ctx.hasUI) {
        ctx.ui.notify(msg, "info");
      } else {
        // Headless pi: surface via stdout so `pi -p /distill-status ...` works.
        console.log(msg);
      }
    },
  });

  // Parallel pi tool: the LLM can query the same state the human gets from
  // /distill-status. Used by agents to decide whether to back off from
  // vault edits while a background distill is in flight (see also the
  // before_agent_start overlap injection next commit).
  pi.registerTool({
    name: "napkin_distill_status",
    label: "Napkin distill status",
    description:
      "Returns JSON listing active napkin distill subprocesses and unmerged distill branches for the current vault. Useful for checking if background vault writes are in progress before the agent makes concurrent edits.",
    promptSnippet:
      "Inspect in-flight napkin distill subprocesses before editing vault files.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const vaultPath = resolveVaultPath(ctx.cwd);
      if (!vaultPath) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "no vault in cwd" }),
            },
          ],
          details: { vault: null, active: [], unmerged: [] },
        };
      }
      const { active, unmerged } = collectDistillStatus(vaultPath);
      const json = distillStatusToJson(active, unmerged);
      return {
        content: [{ type: "text", text: json }],
        details: { vault: vaultPath, active, unmerged },
      };
    },
  });
}

/**
 * Gather the shared status payload consumed by both `/distill-status` and
 * `napkin_distill_status`. Empty arrays on any error (no git, git failure)
 * — status surfaces must never throw.
 *
 * Exported for unit tests. Callers pass the MAIN vault content path (not a
 * worktree). Both inspectors return [] when `.git/` is absent.
 */
export function collectDistillStatus(vaultPath: string): {
  active: ActiveDistill[];
  unmerged: string[];
} {
  return getDistillState({ contentPath: vaultPath });
}

/**
 * Format the `/distill-status` human-readable string. Pure function; exported
 * for unit tests.
 *
 * Output shape (matches the spec "Output format" block in shutdown-distill.md):
 *
 *   Active distills (N):
 *     [PID] Xs  branch=distill/abc-123  session=<basename>
 *     ...
 *   Unmerged branches (M):
 *     distill/xyz-456  (no active process)
 *
 * Zero-active case collapses to the single line `"No active distills."`
 * when there are also zero unmerged branches; otherwise the Unmerged block
 * still renders so the user can see lingering refs.
 */
export function formatDistillStatus(
  active: ActiveDistill[],
  unmerged: string[],
): string {
  const lines: string[] = [];
  if (active.length === 0) {
    lines.push("No active distills.");
  } else {
    lines.push(`Active distills (${active.length}):`);
    for (const d of active) {
      const elapsed = `${Math.floor(d.elapsedMs / 1000)}s`;
      const session =
        d.sessionPath !== null ? path.basename(d.sessionPath) : "unknown";
      const liveness = d.alive ? "" : " (dead)";
      lines.push(
        `  [${d.pid}] ${elapsed}  branch=${d.branch}  session=${session}${liveness}`,
      );
    }
  }

  if (unmerged.length > 0) {
    lines.push(`Unmerged branches (${unmerged.length}):`);
    for (const b of unmerged) {
      lines.push(`  ${b}  (no active process)`);
    }
  }

  return lines.join("\n");
}

/**
 * Serialise the same `(active, unmerged)` payload that `/distill-status`
 * renders to a JSON string for the `napkin_distill_status` pi tool. Pure
 * function; exported for unit tests.
 *
 * Return shape (see shutdown-distill.md — `/distill-status` command):
 *   {
 *     "active": [
 *       {
 *         pid: number,         // -1 when meta.json is unreadable
 *         branch: string,
 *         elapsedSeconds: number,
 *         session: string|null, // basename of parent session .jsonl
 *         alive: boolean,
 *         startedAt: string|null,
 *         startSha?: string,
 *       }
 *     ],
 *     "unmerged": ["distill/xyz-456", ...]
 *   }
 *
 * `session` is the basename of the parent session file (matching the
 * human-readable formatter) — the full path isn't useful to the agent and
 * would leak $HOME. `elapsedSeconds` is an integer (floor).
 *
 * `alive` and `startSha` are retained because they materially change how
 * the agent should interpret an entry (dead distills are candidates for
 * manual cleanup; `startSha` is a forensic hint for recovery).
 *
 * Shape is stable: new keys may be added, existing keys MUST NOT be renamed
 * or repurposed without a version bump.
 */
export function distillStatusToJson(
  active: ActiveDistill[],
  unmerged: string[],
): string {
  const payload = {
    active: active.map((d) => ({
      pid: d.pid,
      branch: d.branch,
      elapsedSeconds: Math.floor(d.elapsedMs / 1000),
      session: d.sessionPath !== null ? path.basename(d.sessionPath) : null,
      alive: d.alive,
      startedAt: d.startedAt,
      startSha: d.startSha,
    })),
    unmerged,
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Compute the intersection of session-touched paths and distill-touched
 * paths. Matching is symmetric-suffix: we tolerate both absolute session
 * paths (`/home/user/.napkin/notes/foo.md`) and worktree-relative distill
 * paths (`notes/foo.md`). Basename-only matching would be too permissive
 * (two `README.md`s aren't the same file); suffix matching on either
 * direction handles the common layouts without false positives.
 *
 * Exported for unit tests. Output is sorted so the overlap notice is
 * deterministic across runs.
 */
export function intersectFiles(
  session: ReadonlySet<string>,
  distill: ReadonlySet<string>,
): string[] {
  if (session.size === 0 || distill.size === 0) return [];

  const hits = new Set<string>();
  for (const d of distill) {
    for (const s of session) {
      if (
        d === s ||
        d.endsWith(`/${s}`) ||
        s.endsWith(`/${d}`) ||
        path.basename(d) === path.basename(s)
      ) {
        // Prefer the distill-side (worktree-relative) path for display;
        // it's shorter and scoped to the vault.
        hits.add(d);
      }
    }
  }
  return [...hits].sort();
}

/**
 * Format the one-line notice appended to `systemPrompt` when overlap
 * between session-touched and distill-touched files is non-empty.
 *
 * Leading `\n\n` separates it from the preceding system-prompt content
 * so it can't accidentally run into the last word of whatever the tail
 * looks like. The warning glyph (⚠️) is there to catch the agent's
 * attention if it happens to narrate the prompt; agents trained on
 * markdown treat it as a signal.
 *
 * Text is deliberately short (~45 tokens): the point of using
 * `systemPrompt` instead of `message` is to avoid context bloat on
 * repeat turns. A single line naming the overlap is enough.
 */
export function formatOverlapNotice(overlapFiles: string[]): string {
  if (overlapFiles.length === 0) return "";
  const list = overlapFiles.join(", ");
  return (
    "\n\n\u26a0\ufe0f Background napkin distill is editing files you've also " +
    `touched: ${list}. Recent writes to these files may be overwritten or ` +
    "merged automatically at distill completion; consider re-reading before " +
    "further edits."
  );
}
