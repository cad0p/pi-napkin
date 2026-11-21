import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Auto-distill session-role gate (issue #116).
 *
 * Every host that loads extensions in-process gets its own pi-napkin
 * activation with its own `session_start` / `session_shutdown`: pi-subagents
 * builds a child `AgentSession` per subagent, an SDK embedder can build one
 * per request, and pi itself replaces the session object on `/fork`,
 * `/tree` branch creation and reload. Only the user's top-level session may
 * run auto-distill. A child's work already reaches the vault through the
 * parent's tool result, so distilling the child transcript duplicates the
 * parent's distill, spawns one extra agent per subagent (RAM spike, frozen
 * windows), and hands the subagent's brief to a distill agent as its
 * conversation (issue #117).
 *
 * Why `hasUI && mode !== "print"`:
 *
 * - `ctx.hasUI` alone cannot identify a child. pi-subagents passes a child UI
 *   proxy to `session.bindExtensions({ uiContext: createChildUIProxy(...) })`
 *   (src/agent-runner.ts), and pi's `hasUI()` is
 *   `uiContext !== noOpUIContext` (dist/core/extensions/runner.js), so a child
 *   reports `hasUI === true` exactly like the TUI. `hasUI` does exclude hosts
 *   that never bind a UI: `pi -p`, headless SDK embedders.
 * - `ctx.mode` is the field that separates a child from a real host session.
 *   `bindExtensions` assigns the mode only when the caller passes one, and pi
 *   defaults `_extensionMode = "print"` (dist/core/agent-session.js:182; the
 *   runner's own default and its `mode` getter are runner.js:168 and :630).
 *   pi-subagents passes `uiContext` and `onError`
 *   only, so every ctx getter in a child reports `mode === "print"`. The
 *   interactive TUI binds `mode: "tui"` (dist/modes/interactive/) and RPC binds
 *   `mode: "rpc"` (dist/modes/rpc/), so a real interactive session never
 *   reports "print".
 * - The session header's `parentSession` is deliberately NOT used. It is true
 *   for a child, but pi also sets it for legitimate top-level sessions: `/new`
 *   with a parent, `/fork`, clone and `/tree` branch creation
 *   (dist/core/agent-session-runtime.js:157-158,205,237;
 *   SessionManager.newSession). Gating on it would silently disable
 *   auto-distill for every forked or resumed-by-fork user session.
 * - `mode` is optional in the ctx type here because an older pi (or a host
 *   that assembles a partial ctx) may not expose it. An absent mode is treated
 *   as "legacy, allow", which keeps the pre-#116 behavior instead of silently
 *   disabling auto-distill for that host.
 *
 * Known limit: a host that binds a child with an explicit non-"print" mode
 * would pass this gate. The durable fix is a pi API for session role (e.g. an
 * `isSubagent` / `sessionRole` on ExtensionContext, or a `bindExtensions`
 * option the host sets) — see issue #116 for the upstream note.
 */
export type AutoDistillSessionCtx = {
  hasUI: boolean;
  mode?: ExtensionContext["mode"];
};

/**
 * True when this session may run auto-distill: an interactive top-level
 * session, never a subagent child. Decided once, at `session_start`.
 */
export function isAutoDistillEligible(ctx: AutoDistillSessionCtx): boolean {
  if (!ctx.hasUI) return false;
  return ctx.mode !== "print";
}
