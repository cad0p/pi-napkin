import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { findVaultPath } from "../vault-resolve.js";

const DEBUG = process.env.NAPKIN_DISTILL_DEBUG === "1";
const LOG_FILE = path.join(os.homedir(), ".pi", "napkin-distill.log");
function dbg(msg: string) {
  if (!DEBUG) return;
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
}

dbg(`EXTENSION LOADED pid=${process.pid}`);

interface DistillConfig {
  enabled: boolean;
  intervalMinutes: number;
  model: { provider: string; id: string };
}

interface DistillContext {
  sessionManager: { getSessionFile?: () => string | null };
  hasUI: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: partial ExtensionContext — pi doesn't export this type
  ui: any;
  cwd: string;
}

// Process-level guards for SIGHUP/SIGTERM handler
let signalHandlerRegistered = false;
let signalSpawned = false;
let latestCtx: DistillContext | null = null;
let latestConfig: DistillConfig | null = null;

/**
 * Check if the session has new content worth distilling.
 */
function shouldDistill(
  ctx: DistillContext,
  lastSize: number,
): { sessionFile: string; currentSize: number } | null {
  const sessionFile = ctx.sessionManager.getSessionFile?.();
  if (!sessionFile) return null;
  let currentSize: number;
  try {
    currentSize = fs.statSync(sessionFile).size;
  } catch {
    return null;
  }
  if (currentSize === 0 || currentSize === lastSize) return null;
  return { sessionFile, currentSize };
}

const DEFAULT_CONFIG: DistillConfig = {
  enabled: false,
  intervalMinutes: 60,
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
};

function loadDistillConfig(vaultPath: string): DistillConfig {
  const configPath = path.join(vaultPath, "config.json");
  if (!fs.existsSync(configPath)) return DEFAULT_CONFIG;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const distill = raw.distill || {};
    return { ...DEFAULT_CONFIG, ...distill };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/**
 * Spawn a detached pi distill process that survives parent exit.
 * Returns immediately — the child runs independently.
 */
function spawnDetachedDistill(
  sessionFile: string,
  cwd: string,
  config: DistillConfig,
): void {
  let tmpSessionDir: string | null = null;
  try {
    tmpSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-distill-"));
    const forkedSm = SessionManager.forkFrom(sessionFile, cwd, tmpSessionDir);
    const forkedSessionFile = forkedSm.getSessionFile();
    if (!forkedSessionFile) {
      fs.rmSync(tmpSessionDir, { recursive: true, force: true });
      return;
    }

    const esc = (s: string) => s.replace(/'/g, "'\\''");
    const escapedTmpDir = esc(tmpSessionDir);
    const escapedLogFile = esc(LOG_FILE);

    // Wrap in a shell that cleans up the temp dir after pi exits
    const piArgs = [
      "--session",
      forkedSessionFile,
      "-p",
      "--model",
      `${config.model.provider}/${config.model.id}`,
      DISTILL_PROMPT,
    ];
    const shellCmd = `trap '' HUP; ${DEBUG ? `echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] START pid=$$ tmpdir='${escapedTmpDir}'" >> '${escapedLogFile}';` : ""} pi ${piArgs.map((a) => `'${esc(a)}'`).join(" ")} >/dev/null 2>&1; ${DEBUG ? `echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] DONE pid=$$ exit=$?" >> '${escapedLogFile}';` : ""} rm -rf '${escapedTmpDir}'`;

    const proc = spawn("sh", ["-c", shellCmd], {
      cwd,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, NAPKIN_DISTILL_NO_RECURSE: "1" },
    });
    proc.unref();
  } catch (err) {
    dbg(`spawnDetachedDistill error: ${err}`);
    if (tmpSessionDir) {
      fs.rmSync(tmpSessionDir, { recursive: true, force: true });
    }
  }
}

const DISTILL_PROMPT = `Distill this conversation into the napkin vault.

1. \`napkin overview\` — learn the vault structure and what exists
2. \`napkin template list\` and \`napkin template read\` — learn the note formats
3. Identify what's worth capturing. The vault structure and templates tell you what kinds of notes belong.
4. For each note:
   a. \`napkin search\` for the topic — if a note already covers it, \`napkin append\` instead of creating a duplicate
   b. Create new notes with \`napkin create\`, following the template format
   c. Add \`[[wikilinks]]\` to related notes

Be selective. Only capture knowledge useful to someone working on this project later. Skip meta-discussion, tool output, and chatter.`;

export default function (pi: ExtensionAPI) {
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let countdownHandle: ReturnType<typeof setInterval> | null = null;
  let lastDistillTimestamp = Date.now();
  let lastSessionSize = 0;
  let isRunning = false;
  let activeProcess: ReturnType<typeof spawn> | null = null;
  let activeTmpDir: string | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const vaultPath = findVaultPath(ctx.cwd);
    if (!vaultPath) return;

    const config = loadDistillConfig(vaultPath);
    if (!config.enabled) {
      if (ctx.hasUI) {
        const theme = ctx.ui.theme;
        ctx.ui.setStatus("napkin-distill", theme.fg("dim", "distill: off"));
      }
      return;
    }

    // Catch SIGHUP/SIGTERM (tmux pane close, kill <pid>) — pi does not
    // handle these, so session_shutdown never fires. Spawn detached distill here.
    latestCtx = ctx;
    latestConfig = config;
    if (!signalHandlerRegistered) {
      signalHandlerRegistered = true;
      const handleSignal = (sig: string) => {
        try {
          if (process.env.NAPKIN_DISTILL_NO_RECURSE) {
            dbg(`${sig}: skip: NO_RECURSE`);
            return;
          }
          if (signalSpawned) {
            dbg(`${sig}: skip: already spawned`);
            return;
          }
          if (!latestCtx || !latestConfig) {
            dbg(`${sig}: skip: no context`);
            return;
          }
          signalSpawned = true;
          dbg(`${sig}: caught pid=${process.pid}`);
          const result = shouldDistill(latestCtx, lastSessionSize);
          if (!result) {
            dbg(`${sig}: skip: nothing to distill`);
            return;
          }
          spawnDetachedDistill(result.sessionFile, latestCtx.cwd, latestConfig);
          dbg(`${sig}: spawned detached distill`);
        } catch (err) {
          dbg(`${sig}: error: ${err}`);
        } finally {
          // Restore default handler and re-raise to actually terminate
          process.removeAllListeners(sig as NodeJS.Signals);
          process.kill(process.pid, sig as NodeJS.Signals);
        }
      };
      process.on("SIGHUP", () => handleSignal("SIGHUP"));
      process.on("SIGTERM", () => handleSignal("SIGTERM"));
    }

    lastDistillTimestamp = Date.now();
    const intervalMs = config.intervalMinutes * 60 * 1000;

    if (ctx.hasUI) {
      const theme = ctx.ui.theme;
      const updateCountdown = () => {
        if (isRunning) return;
        const remaining = Math.max(
          0,
          intervalMs - (Date.now() - lastDistillTimestamp),
        );
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        const display =
          mins > 0
            ? `${mins}m${secs.toString().padStart(2, "0")}s`
            : `${secs}s`;
        ctx.ui.setStatus(
          "napkin-distill",
          theme.fg("dim", `distill: ${display}`),
        );
      };
      updateCountdown();
      countdownHandle = setInterval(updateCountdown, 1000);
    }

    intervalHandle = setInterval(() => {
      if (isRunning) return;
      runDistill(ctx).catch((err) => {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Distill error: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        }
      });
    }, intervalMs);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    dbg(`SHUTDOWN: entered cwd=${ctx.cwd}`);
    // Prevent infinite recursion: detached distill processes must not spawn more distills
    if (process.env.NAPKIN_DISTILL_NO_RECURSE) {
      dbg("SHUTDOWN: skip: NO_RECURSE");
      return;
    }
    // Signal handler already spawned a detached distill — don't double-spawn
    if (signalSpawned) {
      dbg("SHUTDOWN: skip: already spawned by signal handler");
      return;
    }

    if (countdownHandle) {
      clearInterval(countdownHandle);
      countdownHandle = null;
    }
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }

    // If a distill is already running, detach it instead of killing it.
    if (activeProcess && activeTmpDir) {
      dbg("SHUTDOWN: path: activeProcess+activeTmpDir — re-spawning detached");
      const tmpDir = activeTmpDir;
      try {
        activeProcess.kill();
      } catch {
        // already dead — ignore
      }
      activeProcess = null;
      activeTmpDir = null;

      // Re-spawn as detached so it survives parent exit with cleanup
      const vaultPath = findVaultPath(ctx.cwd);
      if (!vaultPath) {
        dbg("SHUTDOWN: skip: no vault");
        return;
      }
      const config = loadDistillConfig(vaultPath);
      if (!config.enabled) {
        dbg("SHUTDOWN: skip: not enabled");
        return;
      }
      const sessionFile = ctx.sessionManager.getSessionFile?.();
      if (!sessionFile) {
        dbg("SHUTDOWN: skip: no session file");
        return;
      }
      spawnDetachedDistill(sessionFile, ctx.cwd, config);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      dbg("SHUTDOWN: re-spawned detached");
      return;
    }

    // No distill running — check if session has new content worth distilling
    const vaultPath = findVaultPath(ctx.cwd);
    dbg(`SHUTDOWN: vaultPath=${vaultPath} cwd=${ctx.cwd}`);
    if (!vaultPath) {
      dbg("SHUTDOWN: skip: no vault");
      return;
    }

    const config = loadDistillConfig(vaultPath);
    if (!config.enabled) {
      dbg("SHUTDOWN: skip: not enabled");
      return;
    }

    const result = shouldDistill(ctx, lastSessionSize);
    if (!result) {
      dbg("SHUTDOWN: skip: nothing to distill");
      return;
    }

    // Spawn a detached distill that outlives this process
    spawnDetachedDistill(result.sessionFile, ctx.cwd, config);
    dbg("SHUTDOWN: spawned detached");
  });

  async function runDistill(ctx: DistillContext) {
    const vaultPath = findVaultPath(ctx.cwd);
    if (!vaultPath) return;

    const config = loadDistillConfig(vaultPath);
    const result = shouldDistill(ctx, lastSessionSize);
    if (!result) {
      if (ctx.hasUI && !ctx.sessionManager.getSessionFile?.()) {
        ctx.ui.notify(
          "Distill: no session file (ephemeral session)",
          "warning",
        );
      }
      lastDistillTimestamp = Date.now();
      return;
    }
    const { sessionFile, currentSize } = result;

    isRunning = true;
    const startTime = Date.now();
    let timerHandle: ReturnType<typeof setInterval> | null = null;
    const theme = ctx.hasUI ? ctx.ui.theme : null;

    if (ctx.hasUI && theme) {
      ctx.ui.setStatus(
        "napkin-distill",
        theme.fg("accent", "●") + theme.fg("dim", " distill"),
      );
      timerHandle = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        ctx.ui.setStatus(
          "napkin-distill",
          theme.fg("accent", "●") + theme.fg("dim", ` distill ${elapsed}s`),
        );
      }, 1000);
    }

    // Fork the session to a temp directory so the subprocess
    // inherits the full conversation without modifying the original
    const tmpSessionDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "napkin-distill-"),
    );
    activeTmpDir = tmpSessionDir;
    let forkedSessionFile: string | null = null;

    try {
      // Fork: creates a new session file with the full conversation
      const forkedSm = SessionManager.forkFrom(
        sessionFile,
        ctx.cwd,
        tmpSessionDir,
      );
      forkedSessionFile = forkedSm.getSessionFile();

      if (!forkedSessionFile) {
        throw new Error("Failed to fork session");
      }

      // Spawn pi on the forked session
      const args = [
        "--session",
        forkedSessionFile,
        "-p",
        "--model",
        `${config.model.provider}/${config.model.id}`,
        DISTILL_PROMPT,
      ];

      const _exitCode = await new Promise<number>((resolve, reject) => {
        const proc = spawn("pi", args, {
          cwd: ctx.cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        activeProcess = proc;

        let stderr = "";
        proc.stderr.on("data", (data) => {
          stderr += data.toString();
        });

        proc.on("error", (err) => {
          activeProcess = null;
          reject(err);
        });

        proc.on("close", (code) => {
          activeProcess = null;
          if (code !== 0 && stderr.trim()) {
            reject(
              new Error(
                `pi exited with code ${code}: ${stderr.trim().slice(0, 200)}`,
              ),
            );
          } else {
            resolve(code ?? 0);
          }
        });
      });

      lastDistillTimestamp = Date.now();
      lastSessionSize = currentSize;

      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      if (ctx.hasUI && theme) {
        ctx.ui.setStatus(
          "napkin-distill",
          theme.fg("success", "✓") + theme.fg("dim", ` distill ${elapsed}s`),
        );
        ctx.ui.notify(`Distillation complete (${elapsed}s)`, "success");
      }
    } catch (err) {
      if (ctx.hasUI && theme) {
        ctx.ui.setStatus(
          "napkin-distill",
          theme.fg("error", "✗") + theme.fg("dim", " distill"),
        );
      }
      throw err;
    } finally {
      if (timerHandle) clearInterval(timerHandle);
      isRunning = false;
      // Clean up forked session — skip if shutdown detached the process
      if (activeTmpDir === tmpSessionDir) {
        fs.rmSync(tmpSessionDir, { recursive: true, force: true });
        activeTmpDir = null;
      }
    }
  }

  // Manual trigger
  pi.registerCommand("distill", {
    description: "Distill conversation knowledge into the vault",
    handler: async (_args, ctx) => {
      const vaultPath = findVaultPath(ctx.cwd);
      if (!vaultPath) {
        if (ctx.hasUI) ctx.ui.notify("No vault found", "error");
        return;
      }

      if (isRunning) {
        if (ctx.hasUI) ctx.ui.notify("Distill already running", "warning");
        return;
      }

      const savedTimestamp = lastDistillTimestamp;
      lastDistillTimestamp = 0;
      lastSessionSize = 0; // bypass size check for manual trigger
      runDistill(ctx)
        .catch((err) => {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `Distill error: ${err instanceof Error ? err.message : String(err)}`,
              "error",
            );
          }
        })
        .finally(() => {
          if (lastDistillTimestamp === 0) {
            lastDistillTimestamp = savedTimestamp;
          }
        });
    },
  });
}
