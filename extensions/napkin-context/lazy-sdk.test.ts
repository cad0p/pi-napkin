/**
 * The napkin SDK stays out of pi's main process until a kb tool needs it
 * (#149). pi loads extensions through jiti, so a static SDK import is
 * transpiled and evaluated at load; the extensions import only
 * `@cad0p/napkin/vault` and load the SDK through `loadNapkinSdk()`.
 *
 * Its own file on purpose: vitest isolates test files, so the SDK loader's
 * module state starts empty here regardless of what other suites did.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { NAPKIN_MARKER } from "@cad0p/napkin/vault";
import { afterEach, describe, expect, test } from "vitest";
import {
  __napkinSdkState,
  __resetNapkinSdkForTests,
} from "../shared/napkin-sdk";
import napkinContext, { __overviewBuildsPending } from "./index";

const EXTENSIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "__snapshots__") {
        out.push(...sourceFiles(p));
      }
    } else if (
      /\.(ts|mts|mjs)$/.test(e.name) &&
      !/\.test\.ts$/.test(e.name) &&
      !e.name.endsWith(".d.ts") &&
      !e.name.startsWith("_test-helpers")
    ) {
      out.push(p);
    }
  }
  return out;
}

const dirs: string[] = [];
const prevDisable = process.env.NAPKIN_CONTEXT_DISABLE_OVERVIEW_WORKER;

afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
  if (prevDisable === undefined) {
    delete process.env.NAPKIN_CONTEXT_DISABLE_OVERVIEW_WORKER;
  } else {
    process.env.NAPKIN_CONTEXT_DISABLE_OVERVIEW_WORKER = prevDisable;
  }
});

function makeVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-lazy-sdk-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, NAPKIN_MARKER), { recursive: true });
  fs.writeFileSync(
    path.join(dir, NAPKIN_MARKER, "config.json"),
    JSON.stringify({ vault: { root: ".." } }),
  );
  fs.writeFileSync(
    path.join(dir, "NAPKIN.md"),
    "# Vault\n\nlazy sdk fixture\n",
  );
  fs.mkdirSync(path.join(dir, "notes"));
  fs.writeFileSync(
    path.join(dir, "notes", "alpha.md"),
    "# Alpha\n\nthe zebracorn lives here\n",
  );
  return dir;
}

type Handler = (event: unknown, ctx: never) => unknown;
type Tool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: unknown,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<{ content: { type: string; text: string }[] }>;
};

function load(): {
  handlers: Map<string, Handler>;
  tools: Map<string, Tool>;
  injected: string[];
} {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const injected: string[] = [];
  napkinContext({
    registerTool: (t: Tool) => tools.set(t.name, t),
    registerMessageRenderer: () => {},
    on: (event: string, h: Handler) => handlers.set(event, h),
  } as never);
  return { handlers, tools, injected };
}

async function sessionStart(
  handlers: Map<string, Handler>,
  cwd: string,
  injected: string[],
): Promise<void> {
  const ctx = {
    cwd,
    hasUI: false,
    isIdle: () => true,
    sessionManager: {
      getEntries: () => [],
      appendCustomMessageEntry: (_type: string, text: string) => {
        injected.push(text);
      },
    },
  };
  await (handlers.get("session_start") as Handler)(undefined, ctx as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const deadline = Date.now() + 15_000;
  while (__overviewBuildsPending.count > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("napkin SDK loads lazily, outside jiti (#149)", () => {
  test("no extension source imports the SDK root at runtime", () => {
    const offenders: string[] = [];
    // A value import (or re-export) of the package root; `import type` and
    // the ./vault subpath are fine. The loader names the package in a
    // createRequire call, not an import.
    const re =
      /^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s*["']@cad0p\/napkin["']|import\(\s*["']@cad0p\/napkin["']\s*\)/m;
    for (const f of sourceFiles(EXTENSIONS)) {
      if (f.endsWith("overview-child.mjs")) continue; // runs in the child, natively
      if (re.test(fs.readFileSync(f, "utf-8"))) {
        offenders.push(path.relative(EXTENSIONS, f));
      }
    }
    expect(offenders).toEqual([]);
  });

  test("session_start and the child-built overview leave the SDK unloaded; the first kb tool loads it once", async () => {
    delete process.env.NAPKIN_CONTEXT_DISABLE_OVERVIEW_WORKER;
    __resetNapkinSdkForTests();
    const vault = makeVault();
    const { handlers, tools, injected } = load();

    expect(__napkinSdkState.loads).toBe(0);
    await sessionStart(handlers, vault, injected);
    expect(injected.length).toBe(1);
    expect(__napkinSdkState.loads).toBe(0);

    const ctx = { cwd: vault };
    const search = await (tools.get("kb_search") as Tool).execute(
      "1",
      { query: "zebracorn" },
      undefined,
      undefined,
      ctx,
    );
    expect(search.content[0]?.text).toContain("alpha");
    expect(__napkinSdkState.loads).toBe(1);

    await (tools.get("kb_outline") as Tool).execute(
      "2",
      { file: "alpha" },
      undefined,
      undefined,
      ctx,
    );
    expect(__napkinSdkState.loads).toBe(1);
  });

  test("the in-thread overview fallback loads the SDK on demand", async () => {
    process.env.NAPKIN_CONTEXT_DISABLE_OVERVIEW_WORKER = "1";
    __resetNapkinSdkForTests();
    const vault = makeVault();
    const { handlers, injected } = load();
    expect(__napkinSdkState.loads).toBe(0);
    await sessionStart(handlers, vault, injected);
    expect(injected.length).toBe(1);
    expect(injected[0]).toContain("notes/");
    expect(__napkinSdkState.loads).toBe(1);
  });
});
