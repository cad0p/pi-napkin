/**
 * Session-start setup notice: when the `napkin` CLI is missing, inject a
 * custom message into the session so the *LLM* — not only the TUI — sees
 * the blocking prerequisite. The TUI notify from
 * `surfaceHealthFindings` is human-facing only; without this message the
 * agent has no way to know auto-distill is broken and cannot repair it on
 * its next turn.
 *
 * Deliberately separate from `ensureVaultReadyForDistill`'s finding
 * channel: the notice uses the cheap PATH-resolution probe (no child
 * process) and does NOT count as a setup failure, so auto-distill stays
 * armed. Once the agent installs the CLI, the next full-level health
 * check passes and the next tick works without a pi restart. If the agent
 * does not repair it, the full-level gate blocks the wrapper spawn and
 * keeps surfacing the loud error.
 *
 * Delivery uses the shared `sendCustomMessageOnce` helper
 * (`pi.sendMessage` primary, direct session append fallback, deduped by
 * customType) so the custom message participates in LLM context exactly
 * like the `<napkin-context>` overview block, and a resumed session does
 * not accumulate duplicate notices.
 */

import type {
  ExtensionAPI,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { sendCustomMessageOnce } from "../shared/custom-message";
import type { NapkinCliProbeResult } from "./auto-setup";

/** customType identifying the session-start setup notice message. */
export const NAPKIN_SETUP_NOTICE_CUSTOM_TYPE = "napkin-distill-setup";

/**
 * Render the agent-facing notice. The install command is the documented
 * prerequisite (README "Install"); the trailing instruction tells the
 * agent to repair it proactively on its next turn instead of merely
 * describing the problem to the user.
 */
export function formatNapkinSetupNotice(error: string | undefined): string {
  return [
    "<napkin-distill-setup>",
    `Auto-distill is blocked: the \`napkin\` CLI required by the distill wrapper is not available on PATH (${error ?? "unknown error"}).`,
    "Repair it when you next act: run `pnpm add -g @cad0p/napkin` (or `npm install -g @cad0p/napkin`), verify with `napkin --version`, then tell the user auto-distill was repaired. No pi restart is needed when the install bin directory is already on PATH.",
    "</napkin-distill-setup>",
  ].join("\n");
}

export interface MaybeInjectNapkinSetupNoticeOptions {
  /** The extension API whose `sendMessage` is fire-and-forget (void). */
  poster: Pick<ExtensionAPI, "sendMessage">;
  /** Captured session manager (fallback append + notice dedupe). */
  sm: Partial<SessionManager> | undefined;
  /** Result of the cheap (no smoke test) napkin CLI probe. */
  probe: NapkinCliProbeResult;
  /** Invoked when the fallback append itself throws. */
  onFallbackFailure?: (err: unknown) => void;
}

/**
 * Inject {@link formatNapkinSetupNotice} when the probe failed.
 * `sendCustomMessageOnce` handles the resume dedupe (one notice per
 * session). No-op on the healthy path. Never throws.
 */
export function maybeInjectNapkinSetupNotice(
  options: MaybeInjectNapkinSetupNoticeOptions,
): void {
  const { poster, sm, probe, onFallbackFailure } = options;
  if (probe.ok) return;
  sendCustomMessageOnce({
    poster,
    sm,
    customType: NAPKIN_SETUP_NOTICE_CUSTOM_TYPE,
    content: formatNapkinSetupNotice(probe.error),
    onFallbackFailure,
  });
}
