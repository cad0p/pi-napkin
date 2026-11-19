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
import { Worker } from "node:worker_threads";
import { NAPKIN_MARKER, Napkin } from "@cad0p/napkin";
import type { Text } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import napkinContext, { __overviewBuildsPending } from "./index";

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
  fs.mkdirSync(path.join(dir, NAPKIN_MARKER), { recursive: true });
  fs.writeFileSync(
    path.join(dir, NAPKIN_MARKER, "config.json"),
    JSON.stringify(config),
  );
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

// napkin < 0.14 auto-creates a bare vault instead of throwing, so the
// no-vault guidance path only exists once the installed SDK throws
// VaultNotFoundError. Probe at module load with an isolated
// XDG_CONFIG_HOME (the real user's global vault must not leak into the
// probe) and skip the test on older SDKs.
const napkinThrowsWithoutVault = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-context-probe-"));
  const configHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "napkin-context-config-"),
  );
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configHome;
  try {
    new Napkin(dir);
    return false;
  } catch (e) {
    return e instanceof Error && e.name === "VaultNotFoundError";
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configHome, { recursive: true, force: true });
  }
})();

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

function loadExtension(
  options: { sendMessage?: (message: unknown, options?: unknown) => void } = {},
): {
  tools: Map<string, RegisteredTool>;
  handlers: Map<string, (event: unknown, ctx: never) => unknown>;
} {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, (event: unknown, ctx: never) => unknown>();
  const pi: Record<string, unknown> = {
    registerTool: (t: RegisteredTool) => {
      tools.set(t.name, t);
    },
    registerMessageRenderer: () => {},
    on: (event: string, handler: (event: unknown, ctx: never) => void) => {
      handlers.set(event, handler);
    },
  };
  // The delivery path only exists when the caller supplies sendMessage.
  // Without it the shared helper's fallback (appendCustomMessageEntry) is
  // exercised, which is what the overview-content tests assert on.
  if (options.sendMessage) pi.sendMessage = options.sendMessage;
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

// session_start defers the overview build via setImmediate, then runs it on
// a worker thread (#132). Drain the deferral, then wait out the worker
// round-trip via the extension's pending-build counter before asserting on
// the injected message/status.
async function flushBackgroundWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  const deadline = Date.now() + 15_000;
  while (__overviewBuildsPending.count > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
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
  // With hasUI the fake UI captures setStatus calls (identity theme, so
  // content is ANSI-free).
  interface SessionStartCapture {
    injected: string[];
    types: string[];
    calls: number;
    setStatusCalls: { id: string; content: string }[];
    handlers: Map<string, (event: unknown, ctx: never) => unknown>;
  }

  interface SessionStartOptions {
    hasUI?: boolean;
    /** Session history probe; mutable so a test can add an entry mid-build. */
    entries?: () => unknown[];
    /** Fake run state. Delivery must not branch on it (no steer, no turn). */
    isIdle?: () => boolean;
    sendMessage?: (message: unknown, options?: unknown) => void;
  }

  // Invokes session_start and returns as soon as the handler resolves — the
  // overview build is still pending. Tests that assert on its delivery use
  // runSessionStart (which flushes) or flushBackgroundWork themselves.
  async function invokeSessionStart(
    vault: string,
    opts: SessionStartOptions = {},
  ): Promise<SessionStartCapture> {
    const { handlers } = loadExtension({
      sendMessage: opts.sendMessage,
    });
    const injected: string[] = [];
    const types: string[] = [];
    const setStatusCalls: { id: string; content: string }[] = [];
    let calls = 0;
    const ctx = {
      cwd: vault,
      sessionManager: {
        getEntries: opts.entries ?? (() => []),
        appendCustomMessageEntry: (type: string, text: string) => {
          calls++;
          types.push(type);
          injected.push(text);
        },
      },
      hasUI: opts.hasUI ?? false,
      isIdle: opts.isIdle ?? (() => true),
      ui: opts.hasUI
        ? {
            theme: identityTheme,
            notify: () => {},
            setStatus: (id: string, content: string) => {
              setStatusCalls.push({ id, content });
            },
          }
        : undefined,
    };
    const handler = handlers.get("session_start");
    if (!handler) throw new Error("session_start handler not registered");
    await handler(undefined, ctx as never);
    return {
      injected,
      types,
      // Getter, not a snapshot: the deferred build appends after the
      // handler (and before runSessionStart returns).
      get calls() {
        return calls;
      },
      setStatusCalls,
      handlers,
    };
  }

  async function runSessionStart(
    vault: string,
    opts: SessionStartOptions = {},
  ): Promise<SessionStartCapture> {
    const capture = await invokeSessionStart(vault, opts);
    await flushBackgroundWork();
    return capture;
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
    // the injected message is data-only now: no preamble, no vault root line
    expect(injected[0]).not.toContain("## Napkin vault context");
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
    // listing-only injection (no NAPKIN.md in this vault): wrapped in the
    // self-describing overview tag
    expect(injected[0]).toContain("<napkin-overview>");
    expect(injected[0]).toContain("</napkin-overview>");
    expect(injected[0]).toContain("./");
    expect(injected[0]).not.toContain("//");
    expect(injected[0]).toContain("notes: 1");
  });

  test("injects the NAPKIN.md content directly with no preamble or vault root line", async () => {
    const vault = makeVault({
      "NAPKIN.md": "# My vault\n\n## What is this?\nfixture context",
    });

    const { injected, calls } = await runSessionStart(vault);

    expect(calls).toBe(1);
    // the message starts directly with the NAPKIN.md CONTENT wrapped in the
    // self-describing tag — the preamble sentence and the "Vault root:" line
    // are gone (the root now lives in the before_agent_start system prompt
    // mandate)
    expect(injected[0]).not.toContain("Vault root:");
    expect(injected[0]).not.toContain("## Napkin vault context");
    expect(injected[0]).toContain("fixture context");
    expect(
      injected[0].startsWith(
        "<napkin-context>\n# My vault\n\n## What is this?\nfixture context\n</napkin-context>",
      ),
    ).toBe(true);
    // NAPKIN.md-only vault: the SDK returns { context, overview: [] }, so no
    // listing block is injected
    expect(injected[0]).not.toContain("<napkin-overview>");
  });

  test("wraps the NAPKIN.md content and folder listing in separate self-describing blocks, context first", async () => {
    const vault = makeVault({
      "NAPKIN.md": "# My vault\n\n## What is this?\nfixture context",
      "notes/a.md": "# A\n\nnote content about fixture notes\n",
    });

    const { injected, calls } = await runSessionStart(vault);

    expect(calls).toBe(1);
    // context block comes first, listing block second, joined by a blank line
    expect(injected[0]).toContain("<napkin-context>");
    expect(injected[0].startsWith("<napkin-context>\n# My vault")).toBe(true);
    expect(injected[0]).toContain("</napkin-context>\n\n<napkin-overview>");
    expect(injected[0].endsWith("</napkin-overview>")).toBe(true);
    expect(injected[0]).toContain("notes/");
  });

  test("injects nothing for an empty vault and keeps the no-NAPKIN.md status", async () => {
    const vault = makeVault({});

    const { injected, calls, setStatusCalls } = await runSessionStart(vault, {
      hasUI: true,
    });

    expect(calls).toBe(0);
    expect(injected).toEqual([]);
    // The build resolved to null (empty vault): status still says there is
    // no NAPKIN.md, as it did before the background build.
    expect(setStatusCalls).toContainEqual({
      id: "napkin",
      content: "napkin: no NAPKIN.md",
    });
  });

  test("skips the build when the session already carries an overview", async () => {
    const vault = makeVault({ "note.md": "# Note\n\nbody\n" });
    const overview = vi.spyOn(Napkin.prototype, "overview");
    try {
      const { injected, calls, setStatusCalls } = await runSessionStart(vault, {
        entries: () => [
          { type: "custom_message", customType: "napkin-context" },
        ],
        hasUI: true,
      });

      expect(overview).not.toHaveBeenCalled();
      expect(calls).toBe(0);
      expect(injected).toEqual([]);
      expect(setStatusCalls).toContainEqual({
        id: "napkin",
        content: "📜 napkin",
      });
    } finally {
      overview.mockRestore();
    }
  });

  test("session_start resolves before the overview is built", async () => {
    const vault = makeVault({ "note.md": "# Note\n\nbody\n" });
    // The overview runs on a worker thread by default (#132), where a
    // main-thread prototype spy cannot see it — pin this deferral-semantics
    // test to the in-thread path so the spy stays meaningful.
    vi.stubEnv("NAPKIN_CONTEXT_DISABLE_OVERVIEW_WORKER", "1");
    const overview = vi.spyOn(Napkin.prototype, "overview");
    try {
      const capture = await invokeSessionStart(vault);

      // The handler has resolved, but the deferred build has not started.
      expect(overview).not.toHaveBeenCalled();
      expect(capture.calls).toBe(0);

      await flushBackgroundWork();

      expect(overview).toHaveBeenCalledTimes(1);
      expect(capture.calls).toBe(1);
      expect(capture.types).toEqual(["napkin-context"]);
    } finally {
      overview.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  test("idle delivery stores the overview without starting a turn", async () => {
    const vault = makeVault({ "note.md": "# Note\n\nbody\n" });
    const sendMessage = vi.fn();
    const { calls } = await runSessionStart(vault, {
      sendMessage,
      isIdle: () => true,
    });

    expect(calls).toBe(0);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [message, options] = sendMessage.mock.calls[0];
    expect(message).toMatchObject({
      customType: "napkin-context",
      display: true,
    });
    expect(options).toEqual({ triggerTurn: false });
    expect(options).not.toHaveProperty("deliverAs");
  });

  test("mid-run delivery never steers or triggers a turn", async () => {
    // The background build can resolve while the first prompt is already
    // running. Steer would keep pi's agent loop alive for an extra LLM
    // call, so busy delivery must stay triggerTurn:false too.
    const vault = makeVault({ "note.md": "# Note\n\nbody\n" });
    const sendMessage = vi.fn();
    const { calls } = await runSessionStart(vault, {
      sendMessage,
      isIdle: () => false,
    });

    expect(calls).toBe(0);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const options = sendMessage.mock.calls[0][1];
    expect(options).toEqual({ triggerTurn: false });
    expect(options).not.toHaveProperty("deliverAs");
  });

  test("a shutdown before the build finishes drops the overview", async () => {
    const vault = makeVault({ "note.md": "# Note\n\nbody\n" });
    const sendMessage = vi.fn();
    const capture = await invokeSessionStart(vault, { sendMessage });
    expect(sendMessage).not.toHaveBeenCalled();

    const shutdown = capture.handlers.get("session_shutdown");
    if (!shutdown) throw new Error("session_shutdown handler not registered");
    await shutdown(undefined, {} as never);
    await flushBackgroundWork();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(capture.calls).toBe(0);
    expect(capture.injected).toEqual([]);
  });

  test("an overview appearing while building is not duplicated", async () => {
    const vault = makeVault({ "note.md": "# Note\n\nbody\n" });
    const entries: unknown[] = [];
    const sendMessage = vi.fn();
    const capture = await invokeSessionStart(vault, {
      sendMessage,
      entries: () => entries,
    });
    expect(sendMessage).not.toHaveBeenCalled();

    // e.g. a fork/resume replaced the history while the build was running.
    entries.push({ type: "custom_message", customType: "napkin-context" });
    await flushBackgroundWork();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(capture.calls).toBe(0);
  });

  test.skipIf(!napkinThrowsWithoutVault)(
    "no vault: session_start surfaces napkin's VaultNotFoundError guidance and sets the no-vault status",
    async () => {
      // Bare temp dir: no .napkin here or in any ancestor. An empty
      // XDG_CONFIG_HOME keeps the real user's global vault out of the
      // resolution, so the SDK must throw VaultNotFoundError.
      const bareDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "napkin-context-novault-"),
      );
      const configHome = fs.mkdtempSync(
        path.join(os.tmpdir(), "napkin-context-config-"),
      );
      const prev = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = configHome;
      try {
        const { injected, types, calls, setStatusCalls } =
          await runSessionStart(bareDir, { hasUI: true });

        expect(calls).toBe(1);
        expect(types[0]).toBe("napkin-context");
        // napkin's VaultNotFoundError message points at the setup paths
        expect(injected[0]).toContain("napkin init");
        expect(setStatusCalls).toContainEqual({
          id: "napkin",
          content: "napkin: no vault",
        });
      } finally {
        if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prev;
        fs.rmSync(bareDir, { recursive: true, force: true });
        fs.rmSync(configHome, { recursive: true, force: true });
      }
    },
  );

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

  describe("worker thread (#132)", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    /** Writes a fixture worker .mjs to a temp dir and returns its path. */
    function writeFixtureWorker(name: string, body: string): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-ctx-wk-"));
      const p = path.join(dir, name);
      fs.writeFileSync(p, body);
      return p;
    }

    test("the worker path injects text identical to the in-thread build", async () => {
      const vault = makeVault({
        "NAPKIN.md": "# My vault\n\n## What is this?\nfixture context",
        "notes/a.md": "# A\n\nnote content about fixture notes\n",
        "notes/b.md": "# B\n\nmore note content about fixture widgets\n",
      });

      // Default path: real worker thread builds the overview.
      const workerRun = await runSessionStart(vault);

      // Escape hatch: same session flow with the worker disabled.
      vi.stubEnv("NAPKIN_CONTEXT_DISABLE_OVERVIEW_WORKER", "1");
      const inThreadRun = await runSessionStart(vault);

      expect(workerRun.calls).toBe(1);
      expect(inThreadRun.calls).toBe(1);
      // Formatting lives on the main thread in both paths, so the injected
      // text must be byte-identical.
      expect(workerRun.injected[0]).toBe(inThreadRun.injected[0]);
      expect(workerRun.injected[0]).toContain("<napkin-context>");
      expect(workerRun.injected[0]).toContain("<napkin-overview>");
    });

    test("falls back to the in-thread build when the worker cannot start", async () => {
      const vault = makeVault({ "note.md": "# Note\n\nbody\n" });
      // A worker entry that does not exist makes the Worker emit 'error';
      // the extension must still deliver the overview via the in-thread path.
      vi.stubEnv(
        "NAPKIN_CONTEXT_OVERVIEW_WORKER_ENTRY",
        path.join(vault, "missing-worker.mjs"),
      );

      const { injected, calls } = await runSessionStart(vault);

      expect(calls).toBe(1);
      expect(injected[0]).toContain("<napkin-overview>");
    });

    test("falls back to the in-thread build when the worker errors mid-build", async () => {
      const vault = makeVault({ "note.md": "# Note\n\nbody\n" });
      const entry = writeFixtureWorker(
        "boom.mjs",
        'throw new Error("fixture worker exploded");\n',
      );
      vi.stubEnv("NAPKIN_CONTEXT_OVERVIEW_WORKER_ENTRY", entry);

      const { injected, calls } = await runSessionStart(vault);

      expect(calls).toBe(1);
      expect(injected[0]).toContain("<napkin-overview>");
    });

    test("a session replaced while the worker builds drops the result", async () => {
      // Slow worker: posts a valid-shaped overview ~200 ms in, so the
      // session_shutdown below lands while the build is still in flight.
      const entry = writeFixtureWorker(
        "slow.mjs",
        'import { parentPort } from "node:worker_threads";\n' +
          "setTimeout(() => {\n" +
          '  parentPort.postMessage({ overview: { context: "late", overview: [] } });\n' +
          "  parentPort.close();\n" +
          "}, 200);\n",
      );
      vi.stubEnv("NAPKIN_CONTEXT_OVERVIEW_WORKER_ENTRY", entry);
      const vault = makeVault({ "note.md": "# Note\n\nbody\n" });
      const sendMessage = vi.fn();
      // Once the session is gone the worker error must NOT trigger the
      // in-thread fallback — that would freeze pi mid-teardown on a large
      // vault for a result the generation guard drops anyway.
      const overview = vi.spyOn(Napkin.prototype, "overview");

      const capture = await invokeSessionStart(vault, { sendMessage });
      // Let the deferred build spawn the worker, then replace the session.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const shutdown = capture.handlers.get("session_shutdown");
      if (!shutdown) throw new Error("session_shutdown handler not registered");
      await shutdown(undefined, {} as never);

      // Wait past the worker's post time; the generation guard must drop it.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await flushBackgroundWork();

      expect(overview).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(capture.calls).toBe(0);
      expect(capture.injected).toEqual([]);
    });

    test("session_shutdown terminates the in-flight worker", async () => {
      // Worker that never posts: without termination it would burn a thread
      // for a minute. The only terminate call possible here is the shutdown
      // handler's (the build never settles).
      const entry = writeFixtureWorker(
        "hang.mjs",
        "setTimeout(() => {}, 60_000);\n",
      );
      vi.stubEnv("NAPKIN_CONTEXT_OVERVIEW_WORKER_ENTRY", entry);
      const terminate = vi.spyOn(Worker.prototype, "terminate");
      const vault = makeVault({ "note.md": "# Note\n\nbody\n" });

      const capture = await invokeSessionStart(vault);
      // Wait until the build is in flight (worker spawned or spawning).
      const deadline = Date.now() + 5_000;
      while (__overviewBuildsPending.count === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // Give the Worker constructor a tick to run inside the build.
      await new Promise<void>((resolve) => setImmediate(resolve));

      const shutdown = capture.handlers.get("session_shutdown");
      if (!shutdown) throw new Error("session_shutdown handler not registered");
      await shutdown(undefined, {} as never);

      expect(terminate).toHaveBeenCalled();
      await flushBackgroundWork();
      expect(capture.calls).toBe(0);
    });
  });
});

describe("before_agent_start (system prompt mandate)", () => {
  // session_start and before_agent_start must come from the SAME
  // loadExtension() call — hasVault/vaultRoot live in the extension
  // closure and only session_start sets them. Run session_start first,
  // then invoke before_agent_start against the same closure state.
  async function runMandate(vault: string): Promise<{
    injected: string[];
    calls: number;
    res: unknown;
  }> {
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
      isIdle: () => true,
    };
    const sessionStart = handlers.get("session_start");
    const beforeAgentStart = handlers.get("before_agent_start");
    if (!sessionStart || !beforeAgentStart) {
      throw new Error("session_start/before_agent_start not registered");
    }
    await sessionStart(undefined, ctx as never);
    // before_agent_start runs while the deferred overview build is still
    // pending, proving the mandate no longer waits for the overview.
    const res = await beforeAgentStart(
      { systemPrompt: "base prompt", systemPromptOptions: {} },
      undefined as never,
    );
    await flushBackgroundWork();
    return { injected, calls, res };
  }

  test("appends the vault mandate to the system prompt when a vault is present", async () => {
    const vault = makeVault({ "note.md": "# Note\n\nbody\n" });

    const { calls, res } = await runMandate(vault);

    expect(calls).toBe(1);
    // vault.contentPath === the fixture dir (proven here via the mandate
    // string); the root does not depend on the overview build.
    expect(res).toEqual({
      systemPrompt:
        "base prompt\n\nA napkin obsidian vault with the user context is available at " +
        `${vault}. Before answering, you must consult it via kb_search.`,
    });
  });

  test("empty vault: no overview injected, but the mandate is still set", async () => {
    const vault = makeVault({});

    const { injected, calls, res } = await runMandate(vault);

    expect(calls).toBe(0);
    expect(injected).toEqual([]);
    // Vault presence now comes from resolution, not from a non-empty
    // overview, so the first prompt knows the vault even on a fresh/empty
    // vault.
    expect(res).toEqual({
      systemPrompt:
        "base prompt\n\nA napkin obsidian vault with the user context is available at " +
        `${vault}. Before answering, you must consult it via kb_search.`,
    });
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
