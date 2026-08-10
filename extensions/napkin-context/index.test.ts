/**
 * Unit tests for the napkin-context kb_* tools.
 *
 * Loads the extension against a mocked `ExtensionAPI` that captures the
 * registered tool definitions, then executes each tool against a throwaway
 * fixture vault in os.tmpdir() (real napkin SDK, real files) — mirroring
 * the distill suite's fixture-vault pattern rather than mocking the SDK.
 *
 * Covered surfaces:
 *   - kb_search: pagination (page size from vault config, page hint),
 *     snippet caps (5/file) and line truncation (200 chars), empty results
 *   - kb_read: section extraction and page slicing
 *   - kb_outline: heading rendering and bare-name resolution into subfolders
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Text } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import napkinContext from "./index";

const SEARCH_CONFIG = {
  // vault.root mirrors the real Goldmine config: sibling layout, content
  // root is the parent of .napkin/. Without it napkin resolves the
  // .napkin dir itself as an embedded vault and searches find nothing.
  vault: { root: ".." },
  search: {
    limit: 30,
    resultsPerPage: 10,
    contextLines: 0,
  },
};

function makeVault(
  files: Record<string, string>,
  config: unknown = SEARCH_CONFIG,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-context-test-"));
  fs.mkdirSync(path.join(dir, ".napkin"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".napkin", "config.json"),
    JSON.stringify(config),
  );
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

interface RenderContext {
  state: { startedAt?: number; endedAt?: number; interval?: unknown };
  executionStarted: boolean;
  isPartial: boolean;
  isError: boolean;
  invalidate: () => void;
  lastComponent?: unknown;
}

interface RegisteredTool {
  name: string;
  execute: (
    _toolCallId: string,
    params: Record<string, unknown>,
    _signal: unknown,
    _onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<{
    content: { type: string; text: string }[];
    details?: unknown;
  }>;
  renderCall?: (
    args: Record<string, unknown>,
    _theme: unknown,
    context: RenderContext,
  ) => Text;
  renderResult?: (
    result: { content: { type: string; text: string }[]; details?: unknown },
    options: { expanded: boolean; isPartial: boolean },
    _theme: unknown,
    context: RenderContext,
  ) => Text;
}

function loadExtension(): {
  tools: Map<string, RegisteredTool>;
  handlers: Map<string, (event: unknown, ctx: never) => void>;
} {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, (event: unknown, ctx: never) => void>();
  const pi = {
    registerTool: (t: RegisteredTool) => {
      tools.set(t.name, t);
    },
    registerMessageRenderer: () => {},
    on: (event: string, handler: (event: unknown, ctx: never) => void) => {
      handlers.set(event, handler);
    },
  };
  napkinContext(pi as never);
  return { tools, handlers };
}

function loadTools(): Map<string, RegisteredTool> {
  return loadExtension().tools;
}

function getTool(
  tools: Map<string, RegisteredTool>,
  name: string,
): RegisteredTool {
  const tool = tools.get(name);
  if (!tool) {
    throw new Error(`tool ${name} not registered`);
  }
  return tool;
}

function textOf(result: { content: { type: string; text: string }[] }): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

// Identity theme: renders ANSI-free so tests can assert on plain text.
const identityTheme = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};

function renderCall(
  tool: RegisteredTool,
  args: Record<string, unknown>,
  context: RenderContext,
): string[] {
  const render = tool.renderCall;
  if (!render) throw new Error(`tool ${tool.name} has no renderCall`);
  return render(args, identityTheme, context)
    .render(200)
    .map((line) => line.trimEnd());
}

function renderResult(
  tool: RegisteredTool,
  result: { content: { type: string; text: string }[]; details?: unknown },
  options: { expanded: boolean; isPartial: boolean },
  context: RenderContext,
): string[] {
  const render = tool.renderResult;
  if (!render) throw new Error(`tool ${tool.name} has no renderResult`);
  return render(result, options, identityTheme, context)
    .render(200)
    .map((line) => line.trimEnd());
}

function makeContext(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    state: {},
    executionStarted: true,
    isPartial: false,
    isError: false,
    invalidate: () => {},
    ...overrides,
  };
}

describe("kb_search", () => {
  test("returns only the first page and appends a continue hint when more pages exist", async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 12; i++) {
      const n = String(i).padStart(2, "0");
      files[`notes/note-${n}.md`] =
        `# Note ${n}\n\nneedle content for note ${n}\n`;
    }
    const vault = makeVault(files);
    const tool = getTool(loadTools(), "kb_search");

    const res = await tool.execute("t", { query: "needle" }, null, null, {
      cwd: vault,
    });
    const text = textOf(res);

    // 10 of 12 results, page metadata present
    expect(text.match(/\*\*notes\/note-\d+\.md\*\*/g)).toHaveLength(10);
    expect(text).toContain(
      "[Page 1 of 2. Use kb_search with page 2 to continue.]",
    );
    expect((res.details as { totalPages: number }).totalPages).toBe(2);
  });

  test("page 2 returns the remainder without a hint", async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 12; i++) {
      const n = String(i).padStart(2, "0");
      files[`notes/note-${n}.md`] =
        `# Note ${n}\n\nneedle content for note ${n}\n`;
    }
    const vault = makeVault(files);
    const tool = getTool(loadTools(), "kb_search");

    const res = await tool.execute(
      "t",
      { query: "needle", page: 2 },
      null,
      null,
      {
        cwd: vault,
      },
    );
    const text = textOf(res);

    expect(text.match(/\*\*notes\/note-\d+\.md\*\*/g)).toHaveLength(2);
    expect(text).not.toContain("continue");
  });

  test("caps snippets per file at 5 with a +N more matches hint", async () => {
    const lines = Array.from(
      { length: 12 },
      (_, i) => `needle line number ${i + 1}`,
    );
    const vault = makeVault({ "many.md": `# Many\n\n${lines.join("\n")}\n` });
    const tool = getTool(loadTools(), "kb_search");

    const res = await tool.execute("t", { query: "needle" }, null, null, {
      cwd: vault,
    });
    const text = textOf(res);

    expect(text.match(/\s{2}needle line number \d+/g)).toHaveLength(5);
    expect(text).toContain("(+7 more matches)");
  });

  test("truncates snippet lines longer than 200 chars", async () => {
    const longLine = `needle ${"x".repeat(300)}`;
    const vault = makeVault({ "long.md": `# Long\n\n${longLine}\n` });
    const tool = getTool(loadTools(), "kb_search");

    const res = await tool.execute("t", { query: "needle" }, null, null, {
      cwd: vault,
    });
    const text = textOf(res);

    expect(text).toContain("…");
    for (const line of text.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(204);
    }
  });

  test("returns a No results found message on a miss", async () => {
    const vault = makeVault({ "a.md": "# A\n\nnothing here\n" });
    const tool = getTool(loadTools(), "kb_search");

    const res = await tool.execute("t", { query: "needle" }, null, null, {
      cwd: vault,
    });
    expect(textOf(res)).toBe("No results found.");
  });
});

describe("kb_read", () => {
  test("extracts a section by heading text", async () => {
    const vault = makeVault({
      "doc.md": `# Doc\n\n## Alpha\nalpha body\n\n## Beta\nbeta body\n`,
    });
    const tool = getTool(loadTools(), "kb_read");

    const res = await tool.execute(
      "t",
      { file: "doc", section: "Alpha" },
      null,
      null,
      { cwd: vault },
    );
    const text = textOf(res);
    expect(text).toContain("alpha body");
    expect(text).not.toContain("beta body");
  });

  test("slices pages of files larger than the 50KB default page size", async () => {
    const big = `# Big\n\n${"needle ".repeat(12_000)}`; // ~72KB
    const vault = makeVault({ "big.md": big });
    const tool = getTool(loadTools(), "kb_read");

    const p1 = await tool.execute("t", { file: "big", page: 1 }, null, null, {
      cwd: vault,
    });
    const p2 = await tool.execute("t", { file: "big", page: 2 }, null, null, {
      cwd: vault,
    });
    const t1 = textOf(p1);
    const t2 = textOf(p2);

    expect(t1).toContain("[Page 1 of 2. Use --page 2 to continue.]");
    expect(t2).not.toContain("continue");
    // SDK contract (@cad0p/napkin src/core/crud.ts): a paginated page
    // NEVER exceeds the page size — the always-appended page hint +
    // outline nudge are budgeted INTO the chunk
    // (chunkBudget = pageSize − maxHint − nudge, so content+suffix ≤
    // pageSize by construction). The pre-0.12.0 SDK sliced a full
    // pageSize chunk and appended the suffix on top
    // (50_000 + 42 + 62 = 50_104 chars), which blew past the old
    // hardcoded 50_100 bound by exactly 4 chars on every run — flake B,
    // issue #49. Assert the contract (≤ 50_000) instead of magic slack
    // numbers so the pin survives SDK text tweaks and fails loudly if
    // the SDK ever regresses.
    expect(t1.length).toBeLessThanOrEqual(50_000);
    expect(t2.length).toBeLessThanOrEqual(50_000);
    // page 1 + page 2 reassemble the file (minus the page hint + the
    // always-on outline nudge the SDK appends to every paginated page)
    const NUDGE =
      "\n\nHINT: Use napkin outline --file <file> to see its structure.";
    const strip = (s: string) =>
      s
        // nudge is appended last, so strip it first, then the page hint
        .replace(
          new RegExp(`${NUDGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
          "",
        )
        .replace(/\n\n\[Page 1 of 2. Use --page 2 to continue.]$/, "");
    expect(strip(t1) + strip(t2)).toBe(big);
  });

  test("reports the resolved path for bare names in details", async () => {
    const vault = makeVault({ "sub/deep/note.md": "# Note\n\nbody\n" });
    const tool = getTool(loadTools(), "kb_read");

    const res = await tool.execute("t", { file: "note" }, null, null, {
      cwd: vault,
    });
    expect((res.details as { path: string }).path).toContain(
      "sub/deep/note.md",
    );
  });
});

describe("kb_outline", () => {
  test("renders heading levels and resolves bare names into subfolders", async () => {
    const vault = makeVault({
      "sub/deep/note.md": `# Top\n\n## Section A\n\n### Sub point\n\n## Section B\n`,
    });
    const tool = getTool(loadTools(), "kb_outline");

    const res = await tool.execute("t", { file: "note" }, null, null, {
      cwd: vault,
    });
    const text = textOf(res);

    expect(text).toContain("## Section A");
    expect(text).toContain("### Sub point");
    expect(text).toContain("## Section B");
    // File: line carries the resolved path, not the bare name
    expect(text).toContain("File:");
    expect(text).toContain("sub/deep/note.md");
    expect((res.details as { path: string }).path).toContain(
      "sub/deep/note.md",
    );
  });

  test("returns the error message for an unresolvable file", async () => {
    const vault = makeVault({ "a.md": "# A\n" });
    const tool = getTool(loadTools(), "kb_outline");

    const res = await tool.execute(
      "t",
      { file: "does-not-exist" },
      null,
      null,
      {
        cwd: vault,
      },
    );
    expect(textOf(res)).toMatch(/not found/i);
    expect((res.details as { headings: unknown[] }).headings).toEqual([]);
  });
});

describe("vault overview (session context)", () => {
  // Runs the session_start handler against a fixture vault and captures the
  // injected custom message, mirroring the other suites' real-SDK pattern.
  async function runSessionStart(
    vault: string,
  ): Promise<{ injected: string[]; calls: number }> {
    const { handlers } = loadExtension();
    const injected: string[] = [];
    let calls = 0;
    const ctx = {
      cwd: vault,
      sessionManager: {
        getEntries: () => [],
        appendCustomMessageEntry: (_type: string, text: string) => {
          calls++;
          injected.push(text);
        },
      },
      hasUI: false,
    };
    const handler = handlers.get("session_start");
    if (!handler) throw new Error("session_start handler not registered");
    await handler(undefined, ctx as never);
    return { injected, calls };
  }

  test("renders homogeneous sibling subfolders as a collapsed row with count", async () => {
    const files: Record<string, string> = {};
    // >=5 lexically homogeneous subfolders trigger the SDK's sibling collapse
    // (COLLAPSE_MIN_CHILDREN = 5, mean pairwise cosine >= 0.15). The parent
    // sits at depth 2 — the default collapseDepth is 2, so it qualifies as a
    // collapse target (depth-1 taxonomy rows never collapse).
    for (let i = 1; i <= 5; i++) {
      const n = String(i).padStart(2, "0");
      files[`imports/docs/part-${n}/note.md`] =
        `# Part ${n}\n\nimported widget manual revision ${n}: ` +
        "installation, configuration, troubleshooting and maintenance.";
    }
    files["other/note.md"] = "# Other\n\nunrelated note about gardening\n";
    const vault = makeVault(files);

    const { injected, calls } = await runSessionStart(vault);

    expect(calls).toBe(1);
    expect(injected[0]).toContain("## Napkin vault context");
    expect(injected[0]).toContain("imports/docs/ (+5 similar subfolders)");
    // collapsed children no longer render as their own rows
    expect(injected[0]).not.toContain("part-0");
    // non-collapsed siblings stay visible
    expect(injected[0]).toContain("other/");
  });

  test("renders vault-root row as ./ instead of //", async () => {
    const files: Record<string, string> = {};
    // A note directly at the vault root (not NAPKIN.md, which is skipped)
    files["stray.md"] =
      "# Stray\n\nroot-level leftover note with unique terms\n";
    const vault = makeVault(files);

    const { injected, calls } = await runSessionStart(vault);

    expect(calls).toBe(1);
    expect(injected[0]).toContain("./");
    expect(injected[0]).not.toContain("//");
    expect(injected[0]).toContain("notes: 1");
  });

  test("does not collapse heterogeneous sibling subfolders", async () => {
    const files: Record<string, string> = {};
    const topics = [
      ["gardening", "tulips compost watering"],
      ["quantum", "qubits entanglement decoherence"],
      ["baking", "sourdough proofing kneading"],
      ["cycling", "cassette derailleur cadence"],
      ["crypto", "wallets hashes signatures"],
    ];
    for (const [name, body] of topics) {
      // parent sits at depth 2 so the collapseDepth guard lets the similarity
      // threshold actually decide (a depth-1 parent would be skipped outright)
      files[`notes2/topics/${name}/note.md`] = `# ${name}\n\n${body}\n`;
    }
    const vault = makeVault(files);

    const { injected } = await runSessionStart(vault);

    // distinct vocabularies sit below the similarity threshold — every
    // sibling renders as its own row
    for (const [name] of topics) {
      expect(injected[0]).toContain(`notes2/topics/${name}/`);
    }
    expect(injected[0]).not.toContain("similar subfolders");
  });

  test("caps the listing at maxRows with a truncation footer and sorts by note count", async () => {
    const files: Record<string, string> = {};
    // 105 heterogeneous single-note folders (each with a disjoint synthetic
    // keyword, so nothing collapses) + one 5-note folder, all under a depth-2
    // parent. SEARCH_CONFIG sets no overview keys, so the SDK defaults apply:
    // maxRows 100, collapseDepth 2.
    for (let i = 0; i < 105; i++) {
      const n = String(i).padStart(3, "0");
      const kw = `zz${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`;
      files[`big/topic-${n}/note.md`] =
        `# Topic ${n}\n\n${kw} ${kw} ${kw} ${kw}.\n`;
    }
    for (let i = 1; i <= 5; i++) {
      files[`big/important/note-${i}.md`] =
        `# Important ${i}\n\ncritical infrastructure planning note ${i}: ` +
        "uptime, capacity, failover, budget.\n";
    }
    const vault = makeVault(files);

    const { injected, calls } = await runSessionStart(vault);

    expect(calls).toBe(1);
    // 106 rows total (important + 105 topics), sorted by (depth, notes desc,
    // path) — the 100-row cap drops the 6 path-last single-note topics
    // (topic-099..topic-104), 1 note each.
    expect(injected[0]).toContain(
      "… 6 more folders (6 notes) — use kb_search to find specific content",
    );
    expect(injected[0]).toMatch(
      /… \d+ more folders \(\d+ notes\) — use kb_search to find specific content/,
    );
    // exactly 100 folder rows survive the cap
    expect(injected[0].match(/^ {2}notes: /gm)).toHaveLength(100);
    expect(injected[0]).toContain("big/topic-098/");
    expect(injected[0]).not.toContain("big/topic-099/");
    // priority sort: the 5-note folder outranks the single-note topics
    expect(injected[0].indexOf("big/important/")).toBeLessThan(
      injected[0].indexOf("big/topic-000/"),
    );
  });
});

describe("kb tool TUI rendering (call line + timing)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("renderCall shows the tool name + arg and starts the timer only once execution begins", () => {
    const tool = getTool(loadTools(), "kb_read");
    const state: RenderContext["state"] = {};
    const invalidate = vi.fn();

    // args arrive before execution: name + arg shown, no timer yet
    const pre = renderCall(
      tool,
      { file: "note" },
      makeContext({ state, executionStarted: false, invalidate }),
    );
    expect(pre).toEqual(["kb_read note"]);
    expect(state.startedAt).toBeUndefined();

    // execution begins: timer records startedAt, call line unchanged
    const started = renderCall(
      tool,
      { file: "note" },
      makeContext({ state, invalidate }),
    );
    expect(started).toEqual(["kb_read note"]);
    expect(state.startedAt).toBeDefined();
    expect(state.endedAt).toBeUndefined();
  });

  test("kb_search and kb_outline render their args in the call line", () => {
    const tools = loadTools();
    const search = renderCall(
      getTool(tools, "kb_search"),
      { query: "needle" },
      makeContext(),
    );
    expect(search).toEqual(["kb_search needle"]);

    const outline = renderCall(
      getTool(tools, "kb_outline"),
      { file: "note" },
      makeContext(),
    );
    expect(outline).toEqual(["kb_outline note"]);
  });

  test("kb_read renderResult shows the resolved File: header and no timing (trivial lookup)", () => {
    const tool = getTool(loadTools(), "kb_read");
    // startedAt is set by renderCall, but kb_read is a trivial lookup —
    // timing is kb_search-only
    const state = { startedAt: Date.now() - 1234 };
    const lines = renderResult(
      tool,
      {
        content: [{ type: "text", text: "body\n" }],
        details: { path: "/vault/sub/deep/note.md" },
      },
      { expanded: false, isPartial: false },
      makeContext({ state }),
    );

    expect(lines[0]).toBe("File: /vault/sub/deep/note.md");
    expect(lines.join("\n")).toContain("body");
    expect(lines.join("\n")).not.toMatch(/Took|Elapsed/);
  });

  test("kb_outline renderResult never renders timing either", () => {
    const tool = getTool(loadTools(), "kb_outline");
    const state = { startedAt: Date.now() - 1234 };
    const lines = renderResult(
      tool,
      { content: [{ type: "text", text: "# Top\n## A\n" }] },
      { expanded: false, isPartial: false },
      makeContext({ state }),
    );
    expect(lines.join("\n")).toContain("# Top");
    expect(lines.join("\n")).not.toMatch(/Took|Elapsed/);
  });

  test("renderResult without a started timer adds no timing line", () => {
    const tool = getTool(loadTools(), "kb_search");
    const lines = renderResult(
      tool,
      { content: [{ type: "text", text: "No results found." }] },
      { expanded: false, isPartial: false },
      makeContext(),
    );
    expect(lines.join("\n")).toContain("No results found.");
    expect(lines.join("\n")).not.toMatch(/Took|Elapsed/);
  });

  test("partial results show a live Elapsed counter (1s invalidate) that lands on Took", () => {
    vi.useFakeTimers();
    const tool = getTool(loadTools(), "kb_search");
    const invalidate = vi.fn();
    const state = { startedAt: Date.now() - 500 };
    const ctx = makeContext({ state, isPartial: true, invalidate });

    const partial = renderResult(
      tool,
      { content: [{ type: "text", text: "partial body" }] },
      { expanded: false, isPartial: true },
      ctx,
    );
    expect(partial.at(-1)).toBe("Elapsed 0.5s");
    expect(state.interval).toBeDefined();

    // the 1s tick re-invalidates the component so the counter redraws
    vi.advanceTimersByTime(1000);
    expect(invalidate).toHaveBeenCalledTimes(1);

    const final = renderResult(
      tool,
      { content: [{ type: "text", text: "final body" }] },
      { expanded: false, isPartial: false },
      makeContext({ state, isPartial: false, invalidate }),
    );
    expect(final.at(-1)).toMatch(/^Took /);
    expect(final.at(-2)).toBe(""); // blank line before Took, matching the native bash tool
    expect(state.interval).toBeUndefined();
  });

  test("timing is TUI-only: never leaked into the model-visible content", async () => {
    // kb_search is the only tool that renders timing — its model-visible
    // content must never contain it
    const tool = getTool(loadTools(), "kb_search");
    const res = await tool.execute("t", { query: "needle" }, null, null, {
      cwd: makeVault({ "doc.md": "# Doc\n\nneedle body\n" }),
    });
    expect(textOf(res)).not.toMatch(/Took|Elapsed/);
  });
});
