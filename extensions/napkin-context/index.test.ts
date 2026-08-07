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
import { describe, expect, test } from "vitest";
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
}

function loadTools(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    registerTool: (t: RegisteredTool) => {
      tools.set(t.name, t);
    },
    registerMessageRenderer: () => {},
    on: () => {},
  };
  napkinContext(pi as never);
  return tools;
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
    expect(text).toContain("(+7 more matches — use kb_read for full context)");
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
    expect(t1.length).toBeLessThan(50_100);
    expect(t2).not.toContain("continue");
    expect(t2.length).toBeLessThan(50_000);
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
