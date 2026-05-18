/**
 * Helpers shared by `scripts/verify-e2e.ts` (and any sibling on-demand
 * integration scripts that need a synthetic pre-populated pi session).
 *
 * Keep this file dependency-free relative to the distill extension so
 * the on-demand harness stays decoupled from the runtime — the helpers
 * here only know about pi's session JSONL format.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";

/**
 * Synthetic 6-message conversation written to `<tmpdir>/session.jsonl`
 * before pi is invoked.
 *
 * Why this exists: the distill prompt's step 7 has an explicit no-content
 * escape hatch ("Be selective" — agent skips merge/squash/push if it judges
 * nothing in the conversation merits capturing). Without a pre-populated
 * session, pi's `-p` mode hands the agent only the prompt itself — no
 * prior conversation — and the agent (correctly) concludes "no content
 * to distill" and bails. The conversation below is substantive enough
 * (a concrete debugging Q&A about Node EPIPE handling on `spawnSync`) to
 * trip the "yes, capture" branch of "Be selective".
 *
 * Topic choice: this codebase itself uses `spawnSync` extensively
 * (including in this verification script), so the conversation reads
 * as a plausible artifact of someone working on adjacent code.
 */
export const SYNTHETIC_CONVERSATION: ReadonlyArray<{
  role: "user" | "assistant";
  text: string;
}> = [
  {
    role: "user",
    text: "I'm getting intermittent EPIPE crashes in a Node script that uses spawnSync with stdio:'inherit' to invoke git inside a larger pipeline. The parent of my Node process is sometimes `head -1`. What's actually happening, and how should I handle it cleanly?",
  },
  {
    role: "assistant",
    text: "EPIPE on a spawnSync child with stdio:'inherit' means the *parent* process's stdout was closed by its downstream consumer (your `head -1`) before the child finished writing. With 'inherit', the child writes directly to the parent's fd 1 — so the broken-pipe condition propagates straight through. Three things to know:\n\n1. spawnSync surfaces this as `r.signal === 'SIGPIPE'` and `r.status === null`, not as a thrown exception. You must check `r.signal` explicitly; checking only `r.status !== 0` will miss it.\n2. Node's default SIGPIPE behavior on child processes is to terminate, which is what you want — masking SIGPIPE globally hides real bugs.\n3. If you want the parent script to exit gracefully when this happens (rather than treating it as a fatal error), branch on `r.signal === 'SIGPIPE'` and exit 0.",
  },
  {
    role: "user",
    text: "Does this also apply to spawnSync with stdio:'pipe' where I read r.stdout afterwards?",
  },
  {
    role: "assistant",
    text: "No — with stdio:'pipe', spawnSync buffers the child's stdout into r.stdout itself, and the child writes to a pipe owned by Node, not to the parent's stdout. SIGPIPE on the *parent* won't propagate to the child because there's no shared write-end. You'd only see EPIPE in the 'pipe' case if you explicitly forward r.stdout to a closed stream after spawnSync returns. The 'inherit' vs 'pipe' distinction is the key — 'inherit' shares fds, 'pipe' doesn't.",
  },
  {
    role: "user",
    text: "So what's the takeaway I should write down for next time?",
  },
  {
    role: "assistant",
    text: "Takeaway for spawnSync error handling:\n\n- Always check both `r.status` AND `r.signal`. Status alone misses signal-terminated children (SIGPIPE, SIGTERM, OOM kill).\n- With stdio:'inherit', signals from the parent's stdout consumer (e.g. `head` closing early) propagate to the child as SIGPIPE. Treat this as an expected exit, not an error.\n- With stdio:'pipe', the child is insulated from parent stdout state; EPIPE there means you misused r.stdout afterwards.\n- Don't `process.on('SIGPIPE', () => {})` to suppress it — that masks legitimate write failures elsewhere.",
  },
];

/**
 * Write a minimal but valid pi v3 session JSONL containing only the
 * synthetic conversation. Pi's session manager validates the header
 * (`type:"session", version:3`) and the parentId chain on load, then
 * appends the new prompt + assistant response when invoked with `-p`.
 *
 * Format reference: pi-coding-agent's `dist/core/session-manager.js`
 * (CURRENT_SESSION_VERSION=3, parseSessionEntries, _appendEntry).
 *
 * The caller owns the `sessionPath`. Typical usage with SessionManager:
 *
 *     const sm = SessionManager.create(parentCwd, sessionsDir);
 *     const sessionFile = sm.getSessionFile();
 *     writeSyntheticSession(sessionFile, vaultPath);
 *
 * SessionManager allocates the on-disk path; this helper writes the raw
 * JSONL content. The wrapper subprocess later reads the file from disk
 * via `getSessionFile()`, so as long as the synthetic content is on disk
 * before the wrapper's session-fork runs, the order is fine.
 */
export function writeSyntheticSession(sessionPath: string, cwd: string): void {
  const sessionId = randomBytes(16).toString("hex");
  const baseTime = Date.parse("2026-05-15T12:00:00.000Z");
  const lines: string[] = [];

  lines.push(
    JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: new Date(baseTime).toISOString(),
      cwd,
    }),
  );

  let prevId: string | null = null;
  SYNTHETIC_CONVERSATION.forEach((m, i) => {
    const id = randomBytes(4).toString("hex");
    const ts = new Date(baseTime + (i + 1) * 1000).toISOString();
    const messageBody: Record<string, unknown> = {
      role: m.role,
      content: [{ type: "text", text: m.text }],
      timestamp: baseTime + (i + 1) * 1000,
    };
    // Assistant entries get a model stamp; pi tolerates missing fields
    // here, but supplying them keeps the loader's model-resolution code
    // path consistent with what an organic session looks like.
    if (m.role === "assistant") {
      messageBody.api = "kiro-api";
      messageBody.provider = "kiro";
      messageBody.model = "claude-sonnet-4-6";
      messageBody.stopReason = "stop";
    }
    lines.push(
      JSON.stringify({
        type: "message",
        id,
        parentId: prevId,
        timestamp: ts,
        message: messageBody,
      }),
    );
    prevId = id;
  });

  fs.writeFileSync(sessionPath, `${lines.join("\n")}\n`);
}
