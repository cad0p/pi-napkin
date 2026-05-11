/**
 * Pure predicate that decides whether a distill subprocess should be spawned
 * at session shutdown. No I/O, no side effects \u2014 callers assemble the inputs.
 *
 * Guard order matches the spec ("Guard order in shutdown handler"):
 *   1. NAPKIN_DISTILL_NO_RECURSE set       \u2192 false  (inside a distill subprocess)
 *   2. event.reason === "reload"           \u2192 false  (session continues; pi 0.74+ fires
 *                                                    session_shutdown before a reload-triggered
 *                                                    session_start, so we avoid double-distill)
 *   3. autoDistillSuppressed === true      \u2192 false  (/distill-auto-this-session off)
 *   4. !config.enabled                     \u2192 false  (vault-level master switch)
 *   5. config.onShutdown === false         \u2192 false  (per-vault shutdown opt-out)
 *   6. !sessionFile                        \u2192 false  (ephemeral session, nothing to fork)
 *   7. currentSize === 0                   \u2192 false  (nothing happened)
 *   8. currentSize === lastSpawnedSize     \u2192 false  (interval distill just took this exact content)
 *   9. currentSize === lastSessionSize     \u2192 false  (previous distill completed on this exact size)
 *   otherwise                              \u2192 true
 *
 * @param event                   Shutdown event. `reason` is optional because pi's
 *                                SessionShutdownEvent carries no `reason` field today
 *                                (checked against pi-coding-agent's types.d.ts). The
 *                                caller in phase B is responsible for populating it
 *                                (e.g., by tracking reload state via session_start).
 * @param config                  Vault distill config.
 * @param autoDistillSuppressed   Session-scoped toggle from /distill-auto-this-session.
 * @param sessionFile             Path to the current session .jsonl, or undefined/empty
 *                                for ephemeral sessions.
 * @param currentSize             Byte size of sessionFile right now.
 * @param lastSpawnedSize         Byte size captured at the last successful distill SPAWN
 *                                (set before completion poll). Dedupes "shutdown just after
 *                                interval fired" without blocking new-content shutdowns.
 * @param lastSessionSize         Byte size captured at the last successful distill COMPLETION.
 */
export interface ShutdownDistillEvent {
  /**
   * Optional because pi's `SessionShutdownEvent` does not currently include a
   * `reason` field \u2014 the caller must detect a pending reload externally and
   * pass it in. When absent, the reload guard is a no-op.
   */
  reason?: string;
}

export interface ShouldDistillOnShutdownConfig {
  enabled: boolean;
  onShutdown: boolean;
}

export function shouldDistillOnShutdown(
  event: ShutdownDistillEvent,
  config: ShouldDistillOnShutdownConfig,
  autoDistillSuppressed: boolean,
  sessionFile: string | undefined | null,
  currentSize: number,
  lastSpawnedSize: number,
  lastSessionSize: number,
): boolean {
  // 1. Recursion guard \u2014 we're inside a distill subprocess.
  if (process.env.NAPKIN_DISTILL_NO_RECURSE) return false;
  // 2. Session is just reloading; it'll pick up again momentarily.
  if (event.reason === "reload") return false;
  // 3. Per-session /distill-auto-this-session off.
  if (autoDistillSuppressed) return false;
  // 4. Master switch.
  if (!config.enabled) return false;
  // 5. Per-vault shutdown opt-out.
  if (config.onShutdown === false) return false;
  // 6. Ephemeral session (nothing to fork).
  if (!sessionFile) return false;
  // 7. Nothing happened.
  if (currentSize === 0) return false;
  // 8. Interval distill just grabbed this exact content (race).
  if (currentSize === lastSpawnedSize) return false;
  // 9. Previous distill completed on this exact content.
  if (currentSize === lastSessionSize) return false;

  return true;
}
