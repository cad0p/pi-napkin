import { type ChildProcess, fork } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Napkin, type VaultOverview } from "@cad0p/napkin";
import {
  type AgentToolResult,
  type ExtensionAPI,
  keyHint,
  type SessionManager,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  hasCustomMessage,
  sendCustomMessageOnce,
} from "../shared/custom-message";

function loadShowStatus(vaultPath: string): boolean {
  const configPath = path.join(vaultPath, "config.json");
  if (!fs.existsSync(configPath)) return true;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return raw.showStatus !== false;
  } catch {
    return true;
  }
}

function formatKbResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  maxCollapsedLines: number,
): string {
  const output = result.content
    .flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("\n")
    .trimEnd();
  if (!output) return "";
  const lines = output.split(/\r?\n/);
  const maxLines = options.expanded ? lines.length : maxCollapsedLines;
  const displayLines = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  let text = `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
  if (remaining > 0) {
    text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
  }
  return text;
}

// ── TUI render helpers (call line + timing) ───────────────────────
//
// renderCall mirrors the built-in read/grep tools (bold tool name +
// accent arg), so the user sees which note was queried/read. The
// timing line mirrors the built-in bash tool's TUI timing
// (pi dist/core/tools/bash.js): renderCall records a start timestamp
// when execution begins, and renderResult renders a live "Elapsed X"
// counter while the result streams and a final "Took X" once it
// lands. Like bash's, the timing line is TUI-only — never included in
// the model-visible content or details, so the agent doesn't see it.
// It is wired up only for kb_search (potentially heavy); the read /
// outline tools are trivial lookups and don't need it.

interface KbRenderState {
  startedAt?: number;
  endedAt?: number;
  interval?: ReturnType<typeof setInterval>;
}

interface KbRenderContext {
  state: KbRenderState;
  executionStarted: boolean;
  isPartial: boolean;
  isError: boolean;
  invalidate: () => void;
  lastComponent?: unknown;
}

function kbFormatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function kbRecordStart(state: KbRenderState, executionStarted: boolean): void {
  if (executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.endedAt = undefined;
  }
}

/** Renders the tool call line (`kb_read <file>`), like native read's `read <path>`. */
function kbRenderCall(
  context: Pick<
    KbRenderContext,
    "state" | "executionStarted" | "lastComponent"
  >,
  label: string,
  arg: string | undefined,
  theme: Theme,
): Text {
  kbRecordStart(context.state, context.executionStarted);
  const text =
    (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  const argDisplay = arg
    ? theme.fg("accent", arg)
    : theme.fg("toolOutput", "...");
  text.setText(`${theme.fg("toolTitle", theme.bold(label))} ${argDisplay}`);
  return text;
}

/**
 * The trailing TUI-only timing line. While the result is still
 * streaming it re-invalidates once a second so the counter ticks.
 */
function kbTimingLine(
  context: Pick<
    KbRenderContext,
    "state" | "isPartial" | "isError" | "invalidate"
  >,
  theme: Theme,
): string {
  const state = context.state;
  if (state.startedAt === undefined) return "";
  if (context.isPartial && !state.interval) {
    state.interval = setInterval(() => context.invalidate(), 1000);
  }
  if (!context.isPartial || context.isError) {
    state.endedAt ??= Date.now();
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  }
  const label = context.isPartial ? "Elapsed" : "Took";
  const endTime = state.endedAt ?? Date.now();
  return `\n\n${theme.fg("muted", `${label} ${kbFormatDuration(endTime - state.startedAt)}`)}`;
}

/**
 * Composes the result body (collapsed/expanded) with an optional
 * header line (e.g. kb_read's resolved path). No timing — used by
 * the trivial read/outline tools.
 */
function kbRenderResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  maxCollapsedLines: number,
  header?: string,
): string {
  const body = formatKbResult(result, options, theme, maxCollapsedLines);
  let text = header ?? "";
  if (body) text = text ? `${text}${body}` : body;
  return text;
}

/** kbRenderResult + the TUI-only timing line (kb_search only). */
function kbRenderTimedResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  maxCollapsedLines: number,
  context: KbRenderContext,
  header?: string,
): string {
  let text = kbRenderResult(result, options, theme, maxCollapsedLines, header);
  const timing = kbTimingLine(context, theme);
  if (timing) text = text ? `${text}${timing}` : timing.replace(/^\n/, "");
  return text;
}

/**
 * Reuse a vault walk younger than this for kb_search (napkin #93). The agent
 * often searches several times in a row; each search would otherwise re-stat
 * every note (~0.4 s on a 28.7k-note vault). Notes written by other processes
 * (distill, other sessions) show up after at most this window.
 */
const SEARCH_FRESHNESS_MS = 5000;

/**
 * Generous bound for a stuck overview child (pi-napkin #139). A 28.7k-note
 * cold build takes ~14 s worst case; 120 s only fires on a genuinely wedged
 * child, which is then SIGKILLed and the in-thread fallback runs.
 */
const OVERVIEW_CHILD_TIMEOUT_MS = 120_000;

/**
 * Test/debug seams. The env names predate the move from worker_thread to a
 * forked child process (#139) and are kept unchanged so existing escape
 * hatches keep working:
 *  - NAPKIN_CONTEXT_DISABLE_OVERVIEW_WORKER forces the in-thread build (also
 *    a user escape hatch if forking misbehaves on an exotic runtime);
 *  - NAPKIN_CONTEXT_OVERVIEW_WORKER_ENTRY points the fork at a different
 *    file (tests use it to inject failing/slow children);
 *  - NAPKIN_CONTEXT_OVERVIEW_TIMEOUT_MS shortens the timeout in tests (a
 *    real 120 s wait is untestable).
 */
function overviewChildDisabled(): boolean {
  return !!process.env.NAPKIN_CONTEXT_DISABLE_OVERVIEW_WORKER;
}

function overviewChildEntry(): string {
  const override = process.env.NAPKIN_CONTEXT_OVERVIEW_WORKER_ENTRY;
  if (override) return override;
  // Plain .mjs next to this file: pi loads index.ts through jiti (which
  // supports import.meta.url under jiti 2.x), but the child needs a file
  // Node can run without a TS loader — a .ts sibling would only work on
  // Node's type-stripping versions, not on the Node range pi supports.
  return fileURLToPath(new URL("overview-child.mjs", import.meta.url));
}

function overviewChildTimeoutMs(): number {
  const override = Number(process.env.NAPKIN_CONTEXT_OVERVIEW_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0
    ? override
    : OVERVIEW_CHILD_TIMEOUT_MS;
}

function getNapkin(cwd: string): Napkin {
  return new Napkin(cwd, { searchFreshnessMs: SEARCH_FRESHNESS_MS });
}

interface OverviewPayload {
  text: string;
}

/** The plain overview object the child posts back (IPC-serializable). */
type RawOverview = (VaultOverview & { root?: string }) | null | undefined;

/**
 * Format a raw VaultOverview (built in-thread or posted back by the child)
 * into the injectable payload. Pure: identical inputs give identical text,
 * which is what the child-vs-in-thread equivalence test asserts.
 */
function formatOverview(overview: RawOverview): OverviewPayload | null {
  if (!overview) return null;

  // The tags delimit the injected blocks so the provider's merge of
  // consecutive user-role turns keeps vault context distinguishable from
  // the user's actual message. Constant tag text keeps the prompt-cache
  // prefix stable.
  const blocks: string[] = [];
  const context = overview.context?.trim();
  if (context) {
    blocks.push(`<napkin-context>\n${context}\n</napkin-context>`);
  }
  if (overview.overview && overview.overview.length > 0) {
    let listing = "";
    for (const folder of overview.overview) {
      const collapsed = folder.collapsedFolders
        ? ` (+${folder.collapsedFolders} similar subfolders)`
        : "";
      // The SDK reports the vault root as "/"; the CLI renders it as
      // "./". Mirror that here — "//" looked like a broken path.
      const path = folder.path === "/" ? "." : folder.path;
      listing += `${path}/${collapsed}\n`;
      if (folder.keywords && folder.keywords.length > 0) {
        listing += `  keywords: ${folder.keywords.join(", ")}\n`;
      }
      listing += `  notes: ${folder.notes}\n`;
    }
    if (overview.truncated) {
      // maxRows cap in the SDK dropped the tail of the sorted listing;
      // tell the agent the vault is bigger than what's shown.
      listing += `\n… ${overview.truncated.rows} more folders (${overview.truncated.notes} notes) — use kb_search to find specific content\n`;
    }
    blocks.push(`<napkin-overview>\n${listing.trimEnd()}\n</napkin-overview>`);
  }
  const body = blocks.join("\n\n").trim();
  if (!body) return null;
  return { text: body };
}

/**
 * Build the injectable overview payload in-thread. Used as the fallback when
 * the child cannot start, errors, or times out — the overview must never
 * disappear just because forking is unavailable.
 */
async function getOverview(n: Napkin): Promise<OverviewPayload | null> {
  try {
    // napkin >= 0.12.3 ships the fork's defaults (collapseDepth 2, maxRows
    // 100) in DEFAULT_CONFIG, so the extension must not diverge from napkin —
    // it relies on napkin's defaults, overridable via the vault config.
    const overview = await n.overview();
    return formatOverview(overview);
  } catch {
    return null;
  }
}

/**
 * Test hook: in-flight background overview builds. The suite polls it to
 * know when the deferred child build has settled instead of racing fixed
 * sleeps; pi itself never reads it.
 */
export const __overviewBuildsPending = { count: 0 };

/**
 * Test hook: pid of the current overview child (null before the first spawn
 * of this process). The suite uses it to prove killed children are really
 * dead (no orphan after shutdown/timeout); pi itself never reads it.
 */
export const __overviewChildPid = { pid: null as number | null };

/**
 * V8 flags for the overview child (#147). A 4 MB young generation makes the
 * scavenger collect the short-lived arrays a miss allocates while decoding
 * per-note blobs before they reach RSS: on a 29.5k-note vault a three-note
 * miss peaks at 183–187 MB instead of 229–242 MB, at the same miss time.
 */
export const OVERVIEW_CHILD_EXEC_ARGV: readonly string[] = [
  "--max-semi-space-size=4",
];

export default function (pi: ExtensionAPI) {
  let hasVault = false;
  let vaultRoot: string | null = null;
  // Bumped by every session_start and session_shutdown. A background
  // overview build captures the value and drops its result when the session
  // it was started for is gone (/new, /resume, /fork, quit).
  let sessionGeneration = 0;
  // The one in-flight overview child (a build exists at most once per
  // session). Tracked so session_shutdown can kill it — a dead session's
  // 850 MB build must not run to completion.
  let overviewChild: ChildProcess | null = null;

  /**
   * Run Napkin.overview() in a forked child process and resolve with the
   * plain result object. Rejects on spawn failure, child error, a posted
   * error, or the timeout; the caller falls back to the in-thread build.
   *
   * A child process — not the #132 worker thread — because a terminated
   * worker's freed heap stays inside pi's process (~330 MB resident after a
   * Goldmine build), while the child's whole footprint returns to the OS on
   * exit. The child is always SIGKILLed here once settled, so none of its
   * memory is retained and no orphan outlives the build.
   */
  function runOverviewInChild(cwd: string): Promise<RawOverview> {
    return new Promise<RawOverview>((resolve, reject) => {
      __overviewChildPid.pid = null;
      let child: ChildProcess;
      try {
        child = fork(overviewChildEntry(), [], {
          // Same node binary, no inherited flags: --inspect/--import-style
          // flags in execArgv would break or hijack the child. Only the
          // child's own heap sizing goes in (OVERVIEW_CHILD_EXEC_ARGV).
          execPath: process.execPath,
          execArgv: [...OVERVIEW_CHILD_EXEC_ARGV],
          // "advanced" is the V8 serializer — the fork() equivalent of the
          // worker's structured-clone postMessage, so the overview object
          // round-trips identical to the in-thread build.
          serialization: "advanced",
          // stderr is piped (bounded tail below) so a child that dies before
          // posting still explains itself; stdin/stdout are unused.
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
      } catch (err) {
        reject(err);
        return;
      }
      overviewChild = child;
      __overviewChildPid.pid = child.pid ?? null;

      // Bounded tail of the child's stderr, appended to exit-before-result
      // errors (a node that cannot find the entry file reports it there).
      let stderrTail = "";
      child.stderr?.on("data", (chunk) => {
        stderrTail = (stderrTail + String(chunk)).slice(-8192);
      });

      const killChild = () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      };
      // SIGKILL a live child when pi exits so no orphan outlives it. The
      // listener is removed on settle, so listeners never pile up across
      // sessions.
      const killOnParentExit = () => killChild();

      const settle = (ok: boolean, v: unknown) => {
        clearTimeout(timer);
        process.off("exit", killOnParentExit);
        if (ok) resolve(v as RawOverview);
        else reject(v);
        if (overviewChild === child) overviewChild = null;
        killChild();
      };
      const timer = setTimeout(() => {
        settle(false, new Error("overview child timed out"));
      }, overviewChildTimeoutMs());
      // Keep the timer from holding the process open if the child dies
      // without settling (defensive; 'exit' covers it).
      timer.unref?.();
      process.once("exit", killOnParentExit);

      child.once(
        "message",
        (msg: { overview?: RawOverview; error?: string }) => {
          if (msg && typeof msg === "object" && "error" in msg && msg.error) {
            settle(false, new Error(`overview child failed: ${msg.error}`));
          } else {
            settle(true, msg?.overview ?? null);
          }
        },
      );
      child.once("error", (err) => settle(false, err));
      child.once("exit", (code, signal) => {
        // Any exit before a message lands is a failed build — including the
        // SIGKILL settle() itself issues, and a child that died on its own
        // (missing entry, throw at module scope). Settling rejects only if
        // not already resolved (a delivered result wins).
        const tail = stderrTail.trimEnd();
        settle(
          false,
          new Error(
            `overview child exited (code ${code}, signal ${signal}) before posting a result` +
              (tail ? ` — stderr: ${tail}` : ""),
          ),
        );
      });

      try {
        child.send({ cwd, searchFreshnessMs: SEARCH_FRESHNESS_MS }, (err) => {
          if (err) settle(false, err);
        });
      } catch (err) {
        settle(false, err);
      }
    });
  }

  /**
   * Yield once before building so a fresh session's session_start resolves
   * without waiting for the overview (up to ~14 s / ~850 MB on a large
   * vault), then build it in a forked child so pi's main thread never
   * freezes and none of the build's memory is retained (pi-napkin #139).
   * Falls back to the in-thread call if the child cannot deliver.
   *
   * The child failing because session_shutdown killed it must NOT fall
   * back: the result would be dropped by the generation guard anyway, and a
   * synchronous in-thread build would freeze pi mid-teardown for seconds on
   * a large vault.
   */
  async function buildOverview(
    n: Napkin,
    cwd: string,
    generation: number,
  ): Promise<OverviewPayload | null> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!overviewChildDisabled()) {
      try {
        return formatOverview(await runOverviewInChild(cwd));
      } catch (err) {
        if (generation !== sessionGeneration) return null;
        console.error(
          "[napkin-context] overview child unavailable; building in-thread:",
          err,
        );
      }
    }
    return getOverview(n);
  }

  pi.registerMessageRenderer(
    "napkin-context",
    (message, { expanded }, theme) => {
      if (!expanded) {
        const label = theme.fg("customMessageLabel", "📜 napkin vault context");
        const hint = theme.fg("dim", " — Ctrl+O to expand");
        return new Text(label + hint, 1, 0);
      }
      // pi typed message.content as `string | (TextContent | ImageContent)[]`;
      // we only ever set string content via appendCustomMessageEntry so just
      // narrow here. Fallback to empty string if an image-bearing custom
      // message sneaks in — the Markdown renderer can't represent images.
      const body =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter(
                (c): c is { type: "text"; text: string } => c.type === "text",
              )
              .map((c) => c.text)
              .join("");
      return new Markdown(
        body,
        1,
        0,
        {
          heading: (t) => theme.fg("mdHeading", t),
          link: (t) => theme.fg("mdLink", t),
          linkUrl: (t) => theme.fg("mdLinkUrl", t),
          code: (t) => theme.fg("mdCode", t),
          codeBlock: (t) => theme.fg("mdCodeBlock", t),
          codeBlockBorder: (t) => theme.fg("mdCodeBlockBorder", t),
          quote: (t) => theme.fg("mdQuote", t),
          quoteBorder: (t) => theme.fg("mdQuoteBorder", t),
          hr: (t) => theme.fg("mdHr", t),
          listBullet: (t) => theme.fg("mdListBullet", t),
          bold: (t) => theme.bold(t),
          italic: (t) => theme.italic(t),
          strikethrough: (t) => theme.strikethrough(t),
          underline: (t) => theme.underline(t),
        },
        { color: (t) => theme.fg("customMessageText", t) },
      );
    },
  );

  pi.on("session_start", async (_event, ctx) => {
    const generation = ++sessionGeneration;

    let n: Napkin;
    try {
      n = getNapkin(ctx.cwd);
    } catch (e) {
      hasVault = false;
      vaultRoot = null;
      // No usable vault (none found, or a refused legacy-layout vault).
      // Surface napkin's own actionable error to BOTH the user (TUI) and the
      // agent (context), so the first session is self-documenting: without
      // this, the kb_* tools are the only discovery path, and a session
      // that never calls them never learns a vault is expected or how to
      // create/configure one.
      if (e instanceof Error && e.name === "VaultNotFoundError") {
        sendCustomMessageOnce({
          poster: pi,
          sm: ctx.sessionManager as Partial<SessionManager>,
          customType: "napkin-context",
          content: e.message,
          onFallbackFailure: (err) => {
            if (ctx.hasUI) {
              ctx.ui.notify(
                `napkin-context: could not surface no-vault guidance (${
                  err instanceof Error ? err.message : String(err)
                })`,
                "warning",
              );
            }
          },
        });
        if (ctx.hasUI) {
          // Unconditional on purpose — unlike the success path it cannot
          // consult loadShowStatus(): no vault exists, so there is no vault
          // config.json to read. The hint must render even when the user
          // never configured showStatus, or nothing explains why no vault
          // context was injected.
          ctx.ui.setStatus(
            "napkin",
            ctx.ui.theme.fg("dim", "napkin: no vault"),
          );
        }
      }
      return;
    }

    // Derive vault presence/root from the resolved vault, not from the
    // overview: the background build may be skipped (resumed history) or
    // still running, and before_agent_start needs the root on the first
    // prompt.
    hasVault = true;
    vaultRoot = n.vault.contentPath;

    const showStatus = ctx.hasUI && loadShowStatus(n.vault.configPath);

    const paintStatus = (hasOverview: boolean): void => {
      if (!showStatus || !ctx.ui) return;
      const theme = ctx.ui.theme;
      ctx.ui.setStatus(
        "napkin",
        hasOverview
          ? `📜${theme.fg("dim", " napkin")}`
          : theme.fg("dim", "napkin: no NAPKIN.md"),
      );
    };

    // Forked and resumed sessions (distill's SessionManager.forkFrom, pi
    // --resume, pi -c) already replay the injected overview in their
    // history. Their prompt-cache prefix is unchanged by it, so rebuilding
    // would burn the full overview just to discard the duplicate.
    if (hasCustomMessage(ctx.sessionManager, "napkin-context")) {
      paintStatus(true);
      return;
    }

    const buildAndDeliver = async (): Promise<void> => {
      __overviewBuildsPending.count++;
      try {
        const overview = await buildOverview(n, ctx.cwd, generation);

        // The session was replaced while the overview built (session_shutdown
        // bumped the generation). Never post into the new session from the
        // old build, and never touch its UI.
        if (generation !== sessionGeneration) return;

        // A message may have appeared while we built; re-check rather than
        // posting a second copy.
        if (hasCustomMessage(ctx.sessionManager, "napkin-context")) {
          paintStatus(true);
          return;
        }

        if (overview) {
          // Send via the public message event path (message_start) so the TUI
          // renders the custom message live. A direct sessionManager append is
          // only picked up by the next full chat rebuild — on /new the chat is
          // rebuilt BEFORE session_start handlers run, so a direct append would
          // leave the vault overview invisible in the new session's chat (the
          // stale line survives as terminal pixels until the next repaint).
          //
          // Never steer and never ask for a turn: a steered message still
          // pending after the final assistant response keeps pi's agent loop
          // going (pi-agent-core getSteeringMessages → another LLM call), and
          // this context must not cost a turn. triggerTurn:false appends it
          // without starting or extending a run — immediately when idle,
          // before the starting messages when a run is about to begin, and at
          // the next turn_end (never mid tool call) when one is in flight.
          sendCustomMessageOnce({
            poster: pi,
            sm: ctx.sessionManager as Partial<SessionManager>,
            customType: "napkin-context",
            content: overview.text,
            sendOptions: { triggerTurn: false },
            onFallbackFailure: (err) => {
              if (ctx.hasUI) {
                ctx.ui.notify(
                  `napkin-context: could not inject vault overview (${
                    err instanceof Error ? err.message : String(err)
                  })`,
                  "warning",
                );
              }
            },
          });
        }

        // A vault without a renderable overview (no NAPKIN.md, empty
        // vault, or a failed build) keeps the "no NAPKIN.md" status.
        paintStatus(!!overview);
      } finally {
        __overviewBuildsPending.count--;
      }
    };

    void buildAndDeliver().catch((err) => {
      // buildOverview turns overview failures into null; anything reaching
      // here happened after session_start returned, so surfacing it there is
      // no longer possible.
      console.error("[napkin-context] background overview failed:", err);
    });
  });

  pi.on("session_shutdown", async () => {
    // Invalidate an in-flight build: its result belongs to the session
    // being torn down (session replacement runs shutdown on the old
    // extension instance before the new one starts).
    sessionGeneration++;
    // And kill the child carrying it: the result would be dropped by the
    // generation guard anyway, so letting a multi-hundred-MB build finish
    // would be pure waste.
    if (overviewChild) {
      try {
        overviewChild.kill("SIGKILL");
      } catch {
        // already gone
      }
      overviewChild = null;
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!hasVault || !vaultRoot) return {};
    return {
      systemPrompt:
        event.systemPrompt +
        `\n\nA napkin obsidian vault with the user context is available at ${vaultRoot}. Before answering, you must consult it via kb_search.`,
    };
  });

  // ── Tools ───────────────────────────────────────────────────────

  pi.registerTool({
    name: "kb_search",
    label: "KB Search",
    description: "Search the knowledge base for notes matching a query",
    promptSnippet: "Search the napkin vault for notes by keyword or topic",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      page: Type.Optional(
        Type.Number({
          description:
            "Page number (1-based). Pass page+1 when the previous result says to continue.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const n = getNapkin(ctx.cwd);
      const page = params.page ?? 1;
      const res = n.searchPaginated(params.query, { page });

      if (res.results.length === 0) {
        return {
          content: [{ type: "text", text: "No results found." }],
          details: { results: [], page },
        };
      }

      // Vault notes often store whole paragraphs on a single source line, so
      // match-only snippets can still be 700+ chars. Cap per-file snippet
      // count and per-line length; full context stays reachable via kb_read.
      const MAX_SNIPPETS_PER_FILE = 5;
      const MAX_SNIPPET_LINE_CHARS = 200;
      let text = res.results
        .map((r) => {
          let entry = `**${r.file}**`;
          const snips = r.snippets ?? [];
          if (snips.length > 0) {
            const shown = snips.slice(0, MAX_SNIPPETS_PER_FILE);
            entry += `\n${shown
              .map((s) => {
                const line =
                  s.text.length > MAX_SNIPPET_LINE_CHARS
                    ? `${s.text.slice(0, MAX_SNIPPET_LINE_CHARS)}…`
                    : s.text;
                return `  ${line}`;
              })
              .join("\n")}`;
            if (snips.length > MAX_SNIPPETS_PER_FILE) {
              entry += `\n  … (+${snips.length - MAX_SNIPPETS_PER_FILE} more matches)`;
            }
          }
          return entry;
        })
        .join("\n\n");

      if (page < res.totalPages) {
        text += `\n\n[Page ${page} of ${res.totalPages}. Use kb_search with page ${page + 1} to continue.]`;
      }

      text +=
        "\n\nHINT: Use kb_read <file> to open a full file. " +
        "Use kb_outline <file> to see its structure.";

      return {
        content: [{ type: "text", text }],
        details: { results: res.results, page, totalPages: res.totalPages },
      };
    },
    renderCall(args, theme, context) {
      return kbRenderCall(context, "kb_search", args.query, theme);
    },
    renderResult(result, options, theme, context) {
      const t =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      t.setText(kbRenderTimedResult(result, options, theme, 15, context));
      return t;
    },
  });

  pi.registerTool({
    name: "kb_read",
    label: "KB Read",
    description: "Read a file from the knowledge base",
    promptSnippet: "Read a note from the napkin vault by name or path",
    parameters: Type.Object({
      file: Type.String({ description: "File name or path to read" }),
      section: Type.Optional(
        Type.String({
          description: "Heading to extract (exact text without # prefix)",
        }),
      ),
      page: Type.Optional(
        Type.Number({ description: "Page number for paginated output" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const n = getNapkin(ctx.cwd);
      const result = n.read(params.file, {
        section: params.section,
        page: params.page,
      });

      return {
        content: [{ type: "text", text: result.content }],
        details: { path: result.path },
      };
    },
    renderCall(args, theme, context) {
      return kbRenderCall(context, "kb_read", args.file, theme);
    },
    renderResult(result, options, theme, context) {
      const t =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      // Napkin resolves bare note names into subfolders, so surface the
      // resolved path in the TUI (agent already sees it via details) —
      // mirrors kb_outline's `File: <path>` line.
      const path = (result.details as { path?: string } | undefined)?.path;
      const header = path
        ? `${theme.fg("muted", `File: ${path}`)}\n`
        : undefined;
      t.setText(kbRenderResult(result, options, theme, 10, header));
      return t;
    },
  });

  pi.registerTool({
    name: "kb_outline",
    label: "KB Outline",
    description: "List headings in a knowledge base file",
    promptSnippet:
      "List headings in a napkin vault note to understand its structure",
    parameters: Type.Object({
      file: Type.String({ description: "File name or path" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const n = getNapkin(ctx.cwd);
      let headings: { level: number; text: string; line: number }[];
      try {
        headings = n.outline(params.file);
      } catch (e: unknown) {
        return {
          content: [{ type: "text", text: (e as Error).message }],
          details: { headings: [] },
        };
      }

      // outline() doesn't return the resolved path and bare note names can
      // resolve into subfolders, so probe a 1-byte read which returns the
      // resolved path. Fall back to the naive join if resolution fails.
      let absPath = path.join(n.vault.contentPath, params.file);
      try {
        absPath = n.read(params.file, { page: 1, pageSize: 1 }).path;
      } catch {
        // keep the join fallback
      }

      const lines = [`File: ${absPath}`];
      for (const h of headings) {
        lines.push(`${"#".repeat(h.level)} ${h.text}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { path: absPath, headings },
      };
    },
    renderCall(args, theme, context) {
      return kbRenderCall(context, "kb_outline", args.file, theme);
    },
    renderResult(result, options, theme, context) {
      const t =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      t.setText(kbRenderResult(result, options, theme, 15));
      return t;
    },
  });
}
