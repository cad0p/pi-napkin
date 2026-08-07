import * as fs from "node:fs";
import * as path from "node:path";
import { Napkin } from "@cad0p/napkin";
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

function getNapkin(cwd: string): Napkin {
  return new Napkin(cwd);
}

function getOverview(n: Napkin): string | null {
  try {
    const overview = n.overview();
    if (!overview) return null;

    let text = overview.context || "";
    if (overview.overview && overview.overview.length > 0) {
      text += "\n\n";
      for (const folder of overview.overview) {
        const collapsed = folder.collapsedFolders
          ? ` (+${folder.collapsedFolders} similar subfolders)`
          : "";
        // The SDK reports the vault root as "/"; the CLI renders it as
        // "./". Mirror that here — "//" looked like a broken path.
        const path = folder.path === "/" ? "." : folder.path;
        text += `${path}/${collapsed}\n`;
        if (folder.keywords && folder.keywords.length > 0) {
          text += `  keywords: ${folder.keywords.join(", ")}\n`;
        }
        text += `  notes: ${folder.notes}\n`;
      }
      if (overview.truncated) {
        // maxRows cap in the SDK dropped the tail of the sorted listing;
        // tell the agent the vault is bigger than what's shown.
        text += `\n… ${overview.truncated.rows} more folders (${overview.truncated.notes} notes) — use kb_search to find specific content\n`;
      }
    }
    return text.trim() || null;
  } catch {
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  let hasVault = false;

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
    let n: Napkin;
    try {
      n = getNapkin(ctx.cwd);
    } catch {
      return;
    }

    const overview = getOverview(n);
    hasVault = !!overview;

    if (overview) {
      // Check if we already injected context in this session
      const alreadyInjected = ctx.sessionManager
        .getEntries()
        .some(
          (e) =>
            e.type === "custom_message" &&
            (e as { customType?: string }).customType === "napkin-context",
        );

      if (!alreadyInjected) {
        // pi's ExtensionContext narrows sessionManager to
        // ReadonlySessionManager, which omits mutation methods. At runtime
        // it's always the full SessionManager, but if pi ever wraps the
        // instance in a genuine readonly proxy the mutation method will
        // either be absent or throw. Guard both the duck-type and the
        // call so the worst-case is a degraded (no context injection)
        // session, not a fatal extension error. (R2-2)
        const sm = ctx.sessionManager as Partial<SessionManager>;
        if (typeof sm.appendCustomMessageEntry === "function") {
          try {
            sm.appendCustomMessageEntry(
              "napkin-context",
              "## Napkin vault context\n" +
                "You have access to a napkin vault (Obsidian-compatible knowledge base). " +
                "Here is the vault overview. Use the kb_search tool to find specific content, " +
                "kb_read to read files, and kb_outline to see file structure.\n\n" +
                overview,
              true,
            );
          } catch (err) {
            // Graceful degradation: pi may have tightened the readonly
            // contract at runtime. Surface once, then proceed without
            // context injection.
            if (ctx.hasUI) {
              ctx.ui.notify(
                `napkin-context: could not inject vault overview (${
                  err instanceof Error ? err.message : String(err)
                })`,
                "warning",
              );
            }
          }
        }
      }
    }

    if (ctx.hasUI && loadShowStatus(n.vault.configPath)) {
      const theme = ctx.ui.theme;
      if (hasVault) {
        ctx.ui.setStatus("napkin", `📜${theme.fg("dim", " napkin")}`);
      } else {
        ctx.ui.setStatus("napkin", theme.fg("dim", "napkin: no NAPKIN.md"));
      }
    }
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
              entry += `\n  … (+${snips.length - MAX_SNIPPETS_PER_FILE} more matches — use kb_read for full context)`;
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
    renderResult(result, options, theme, context) {
      const t =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      t.setText(formatKbResult(result, options, theme, 15));
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
    renderResult(result, options, theme, context) {
      const t =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      t.setText(formatKbResult(result, options, theme, 10));
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
    renderResult(result, options, theme, context) {
      const t =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      t.setText(formatKbResult(result, options, theme, 15));
      return t;
    },
  });
}
