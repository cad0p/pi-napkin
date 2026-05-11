import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Napkin } from "@cad0p/napkin";
import type {
  CustomEntry,
  ExtensionAPI,
  SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

import {
  cleanupDistillWorkspace,
  cleanupStaleWorktrees,
  DistillError,
  type DistillWorkspace,
  spawnDistillInWorktree,
} from "./distill-workspace";
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

const MAX_DISTILL_DURATION_MS = 10 * 60 * 1000; // 10 minutes

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

Be selective. Only capture knowledge useful to someone working on this project later. Skip meta-discussion, tool output, and chatter.`;

/**
 * Escape a string for use in single-quoted shell arguments.
 */
function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/**
 * Spawn a detached pi distill process that survives parent exit.
 * The shell wrapper cleans up the temp dir when pi finishes.
 * Returns the temp dir path (used as a completion marker — when it disappears, distill is done).
 */
function spawnDistill(
  sessionFile: string,
  cwd: string,
  config: DistillConfig,
): string | null {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-distill-"));

  try {
    const forkedSm = SessionManager.forkFrom(sessionFile, cwd, tmpDir);
    const forkedFile = forkedSm.getSessionFile();
    if (!forkedFile) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return null;
    }

    const piArgs = ["--session", forkedFile, "-p"];

    if (config.model) {
      piArgs.push("--model", `${config.model.provider}/${config.model.id}`);
    }

    piArgs.push(DISTILL_PROMPT);

    // Shell wrapper: run pi, then clean up temp dir regardless of exit code
    const escapedArgs = piArgs.map((a) => `'${shellEscape(a)}'`).join(" ");
    const cmd = `pi ${escapedArgs} >/dev/null 2>&1; rm -rf '${shellEscape(tmpDir)}'`;

    const proc = spawn("sh", ["-c", cmd], {
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
  let uiRef: {
    hasUI: boolean;
    // biome-ignore lint/suspicious/noExplicitAny: partial ExtensionContext
    ui: any;
    showStatus: boolean;
    intervalMs: number;
  } | null = null;

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

    // Sweep out stale distill worktrees left behind by crashed pi sessions.
    // Idempotent, best-effort — never throws, never blocks session_start.
    try {
      cleanupStaleWorktrees({ contentPath: napkinVault.contentPath });
    } catch {
      // swallow — cleanup is non-critical to session lifecycle
    }

    // Restore the per-session pause state from the session file so that
    // resuming a session retains the `/distill-auto-this-session` setting.
    autoDistillSuppressed = readPersistedSuppressed(ctx.sessionManager);

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
      let vaultConfigPath: string | null = null;
      try {
        vaultConfigPath = new Napkin(ctx.cwd).vault.configPath;
      } catch {
        // No vault resolvable — skip spawn, proceed to final resets.
      }
      if (vaultConfigPath) {
        const { distill: config } = loadVaultConfig(vaultConfigPath);
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
          // Guard: we require git for the worktree path. Phase C's auto-init
          // will ensure this; for Phase B, we silently skip if missing —
          // shutdown is not the moment to surface UI hints.
          if (fs.existsSync(path.join(ctx.cwd, ".git")) && sessionFile) {
            const modelStr = config.model
              ? `${config.model.provider}/${config.model.id}`
              : undefined;
            spawnDistillInWorktree({
              vault: ctx.cwd,
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

  function runDistill(ctx: {
    // biome-ignore lint/suspicious/noExplicitAny: partial ExtensionContext
    sessionManager: any;
    hasUI: boolean;
    // biome-ignore lint/suspicious/noExplicitAny: partial ExtensionContext
    ui: any;
    cwd: string;
  }) {
    if (isRunning) return;

    let vaultConfigPath: string;
    try {
      vaultConfigPath = new Napkin(ctx.cwd).vault.configPath;
    } catch {
      return;
    }

    const { showStatus, distill: config } = loadVaultConfig(vaultConfigPath);
    const sessionFile = ctx.sessionManager.getSessionFile?.();
    if (!sessionFile) return;

    // Skip if session hasn't changed since last distill
    const currentSize = fs.existsSync(sessionFile)
      ? fs.statSync(sessionFile).size
      : 0;
    if (currentSize > 0 && currentSize === lastSessionSize) {
      lastDistillTimestamp = Date.now();
      return;
    }

    const tmpDir = spawnDistill(sessionFile, ctx.cwd, config);
    if (!tmpDir) {
      if (ctx.hasUI && ctx.ui.theme && showStatus) {
        ctx.ui.setStatus(
          "napkin-distill",
          ctx.ui.theme.fg("error", "✗") +
            ctx.ui.theme.fg("dim", " distill: spawn failed"),
        );
      }
      return;
    }

    // Record the size we spawned on so a shutdown firing between here and
    // completion dedupes against the in-flight distill. Consumed by
    // shouldDistillOnShutdown (wired in phase B).
    lastSpawnedSize = currentSize;

    isRunning = true;
    const startTime = Date.now();
    const theme = ctx.hasUI ? ctx.ui.theme : null;

    if (ctx.hasUI && theme && showStatus) {
      ctx.ui.setStatus(
        "napkin-distill",
        theme.fg("accent", "●") + theme.fg("dim", " distill"),
      );
    }

    // Poll for completion: temp dir disappears when the shell wrapper finishes
    pollHandle = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const timedOut = Date.now() - startTime > MAX_DISTILL_DURATION_MS;

      if (fs.existsSync(tmpDir) && !timedOut) {
        // Still running — update elapsed time in status bar
        if (ctx.hasUI && theme && showStatus) {
          ctx.ui.setStatus(
            "napkin-distill",
            theme.fg("accent", "●") + theme.fg("dim", ` distill ${elapsed}s`),
          );
        }
        return;
      }

      // Done or timed out
      if (pollHandle) {
        clearInterval(pollHandle);
        pollHandle = null;
      }
      isRunning = false;

      if (timedOut) {
        // Clean up orphaned temp dir
        fs.rmSync(tmpDir, { recursive: true, force: true });
        if (ctx.hasUI && theme) {
          if (showStatus) {
            ctx.ui.setStatus(
              "napkin-distill",
              theme.fg("error", "✗") + theme.fg("dim", " distill: timeout"),
            );
          }
          ctx.ui.notify("Distillation timed out (10m)", "error");
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
        ctx.ui.notify(`Distillation complete (${elapsed}s)`, "success");
      }
    }, 2000);
  }

  /**
   * Worktree-backed auto-distill path — used by the interval timer and the
   * shutdown handler (Item 8). Concurrency-safe via per-distill git worktrees:
   * each call spawns a detached wrapper that operates on its own branch, so
   * overlapping distills (interval + shutdown, or multiple pi sessions on
   * the same vault) merge serially on main via the LLM merge driver.
   *
   * Deliberately parallel to `runDistill` rather than a refactor — the spec's
   * Phase B Item 7 calls for additive implementation so manual `/distill`
   * keeps working in vaults without git. Phase C may unify the two once
   * auto-init ensures git is always available.
   *
   * Bookkeeping contract matches `runDistill`:
   *   - `lastSpawnedSize` set on successful spawn (pre-poll dedup for shutdown)
   *   - `isRunning` true while the wrapper's worktree exists
   *   - `lastSessionSize` set on successful completion (post-completion dedup)
   *   - `lastDistillTimestamp` updated on completion or no-op skip
   */
  function runAutoDistill(ctx: {
    // biome-ignore lint/suspicious/noExplicitAny: partial ExtensionContext
    sessionManager: any;
    hasUI: boolean;
    // biome-ignore lint/suspicious/noExplicitAny: partial ExtensionContext
    ui: any;
    cwd: string;
  }) {
    if (isRunning) return;

    let vaultConfigPath: string;
    try {
      vaultConfigPath = new Napkin(ctx.cwd).vault.configPath;
    } catch {
      return;
    }

    const { showStatus, distill: config } = loadVaultConfig(vaultConfigPath);
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

    // Pre-flight: auto-distill requires the vault to be a git repo. Phase C's
    // auto-init will wire this at session_start; for Phase B, surface a
    // one-shot UI hint and return quietly — don't throw out of setInterval.
    if (!fs.existsSync(path.join(ctx.cwd, ".git"))) {
      if (ctx.hasUI && theme && showStatus) {
        ctx.ui.setStatus(
          "napkin-distill",
          theme.fg("error", "✗") + theme.fg("dim", " distill: needs git"),
        );
      }
      return;
    }

    let result: {
      workspace: DistillWorkspace;
      pid: number;
    };
    try {
      const modelStr = config.model
        ? `${config.model.provider}/${config.model.id}`
        : undefined;
      result = spawnDistillInWorktree({
        vault: ctx.cwd,
        sessionFile,
        prompt: DISTILL_PROMPT,
        model: modelStr,
      });
    } catch (err) {
      // DistillError from workspace layer (branch collision, fork failure,
      // git issue) — don't update state, surface in the status bar, let the
      // next interval try again.
      if (ctx.hasUI && theme && showStatus) {
        const msg =
          err instanceof DistillError
            ? "distill: setup failed"
            : "distill: spawn failed";
        ctx.ui.setStatus(
          "napkin-distill",
          theme.fg("error", "✗") + theme.fg("dim", ` ${msg}`),
        );
      }
      return;
    }

    // Mirror runDistill's bookkeeping: record spawn size so a shutdown
    // firing between here and completion dedupes against this in-flight run.
    lastSpawnedSize = currentSize;
    const workspace = result.workspace;

    isRunning = true;
    const startTime = Date.now();

    if (ctx.hasUI && theme && showStatus) {
      ctx.ui.setStatus(
        "napkin-distill",
        theme.fg("accent", "●") + theme.fg("dim", " distill"),
      );
    }

    // Poll for completion by watching the worktree path. The wrapper's EXIT
    // trap calls `git worktree remove --force` which deletes the directory;
    // once the dir is gone the distill lifecycle (commit + merge + squash)
    // is complete.
    pollHandle = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const timedOut = Date.now() - startTime > MAX_DISTILL_DURATION_MS;

      if (fs.existsSync(workspace.worktreePath) && !timedOut) {
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
        // Force-cleanup the worktree + branch if the wrapper stalled. Best
        // effort — if the wrapper is still active inside the worktree, the
        // force-remove may leave it flailing against deleted files, but it'll
        // exit on its own once its next git command fails.
        try {
          cleanupDistillWorkspace(ctx.cwd, workspace);
        } catch {
          // ignore — status bar still reports timeout below
        }
        if (ctx.hasUI && theme) {
          if (showStatus) {
            ctx.ui.setStatus(
              "napkin-distill",
              theme.fg("error", "✗") + theme.fg("dim", " distill: timeout"),
            );
          }
          ctx.ui.notify("Distillation timed out (10m)", "error");
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
        ctx.ui.notify(`Distillation complete (${elapsed}s)`, "success");
      }
    }, 2000);
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
}
