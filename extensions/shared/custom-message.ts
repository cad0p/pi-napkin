import type {
  ExtensionAPI,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

export interface SendCustomMessageWithFallbackOptions {
  /** The extension API whose `sendMessage` is fire-and-forget (void). */
  poster: Pick<ExtensionAPI, "sendMessage">;
  /**
   * The captured session manager for the fallback append. pi narrows the
   * ExtensionContext type to `ReadonlySessionManager` at compile time, so
   * callers pass `ctx.sessionManager as Partial<SessionManager>` — the
   * runtime object is the full SessionManager.
   */
  sm: Partial<SessionManager> | undefined;
  customType: string;
  content: string;
  /** Defaults to `true` (surface in the TUI). */
  display?: boolean;
  /**
   * Invoked when the fallback append itself throws (e.g. a genuinely
   * readonly manager at runtime). Lets callers surface a warning;
   * omitted = silent best-effort.
   */
  onFallbackFailure?: (err: unknown) => void;
}

/**
 * Deliver an extension custom message so the TUI renders it live, with a
 * graceful fallback. Never throws.
 *
 * Primary path: `pi.sendMessage` (public extension API, fire-and-forget /
 * void). In the idle case `sendCustomMessage` appends the entry to the
 * session manager synchronously AND emits `message_start`, so the TUI
 * renders the message immediately. A direct `sessionManager.append`
 * is only picked up by the next full chat rebuild (e.g. /reload): on
 * `/new` the chat is rebuilt BEFORE `session_start` handlers run, so a
 * direct append never becomes a TUI component in the new session (the
 * stale line survives as terminal pixels until the next repaint), and
 * mid-session appends stay invisible until a rebuild. (Verified
 * empirically 2026-08-11: direct mid-session append invisible in TUI,
 * sendMessage renders immediately.)
 *
 * Fallback: when `sendMessage` throws — e.g. the spawning session's
 * runtime was invalidated by a session switch (e.g. /new) while the
 * call was in flight: `assertActive()` throws synchronously — append
 * directly on the captured session manager, which keeps working and
 * surfaces on the next rebuild (e.g. resume).
 *
 * Known divergences of the primary path (best-effort by design; no
 * extension-visible `isStreaming` exists):
 * - While the parent agent is streaming, `sendMessage` routes to
 *   `agent.steer()`: the message is drained into the running turn, the
 *   agent runs an extra assistant response, and the TUI render + session
 *   append are deferred until drain.
 */
export function sendCustomMessageWithFallback(
  options: SendCustomMessageWithFallbackOptions,
): void {
  const {
    poster,
    sm,
    customType,
    content,
    display = true,
    onFallbackFailure,
  } = options;
  try {
    poster.sendMessage({ customType, content, display });
  } catch {
    if (sm && typeof sm.appendCustomMessageEntry === "function") {
      try {
        sm.appendCustomMessageEntry(customType, content, display);
      } catch (err) {
        onFallbackFailure?.(err);
      }
    }
  }
}

/**
 * Whether the session history already contains a custom message of
 * `customType`. Session-start injections replay on resumed sessions (the
 * prior message is already in LLM context), so callers use this to dedupe
 * rather than injecting a duplicate copy of the same guidance.
 *
 * Unreadable histories (`getEntries` absent or throwing) report `false`:
 * the caller proceeds with the send and at worst produces one duplicate.
 */
export function hasCustomMessage(
  sm: Partial<SessionManager> | undefined,
  customType: string,
): boolean {
  if (!sm || typeof sm.getEntries !== "function") return false;
  try {
    return sm
      .getEntries()
      .some(
        (e) =>
          e.type === "custom_message" &&
          (e as { customType?: string }).customType === customType,
      );
  } catch {
    return false;
  }
}

/**
 * {@link sendCustomMessageWithFallback}, deduped against session history:
 * sends only when no custom message of `customType` is present yet, so a
 * resumed session does not accumulate duplicate session-start guidance.
 *
 * Returns whether delivery was attempted (`false` = already present).
 * Best-effort like the underlying helper: a failed primary path falls
 * back to a direct append, and a double failure is reported through
 * `onFallbackFailure` without throwing.
 */
export function sendCustomMessageOnce(
  options: SendCustomMessageWithFallbackOptions,
): boolean {
  if (hasCustomMessage(options.sm, options.customType)) return false;
  sendCustomMessageWithFallback(options);
  return true;
}
