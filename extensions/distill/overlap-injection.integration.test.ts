/**
 * Integration tests for the `before_agent_start` overlap-injection HANDLER.
 * The pure helpers (`intersectFiles`, `formatOverlapNotice`) are covered in
 * `overlap-injection.test.ts`. This file tests the wiring: env guard, vault
 * resolution, session walking, active-distill filtering, diff union, and
 * the final systemPrompt append.
 *
 * Shape: register the extension against a captured-handler mock API
 * (`routing.test.ts` pattern), construct a real git vault with an active
 * distill worktree (meta.json points at this test process's pid so `alive`
 * is true), seed a SessionManager with a write-tool assistant message,
 * invoke the handler, assert the returned systemPrompt.
 *
 * Covers G2 (coverage-review).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@mariozechner/pi-coding-agent";

import distillExtension from "./index";

/**
 * Capture pi.on / registerCommand handlers. Matches the pattern used by
 * `routing.test.ts` and `shutdown-handler.test.ts`.
 */
interface CapturedAPI {
  // biome-ignore lint/suspicious/noExplicitAny: opaque handlers
  handlers: Record<string, (event: any, ctx: any) => Promise<any> | any>;
  commands: Record<
    string,
    // biome-ignore lint/suspicious/noExplicitAny: opaque handlers
    { handler: (args: string, ctx: any) => Promise<void> | void }
  >;
}

function makeMockAPI(): { api: unknown; captured: CapturedAPI } {
  const captured: CapturedAPI = { handlers: {}, commands: {} };
  const api = {
    // biome-ignore lint/suspicious/noExplicitAny: loose pi shape
    on(event: string, handler: any) {
      captured.handlers[event] = handler;
    },
    // biome-ignore lint/suspicious/noExplicitAny: loose pi shape
    registerCommand(name: string, opts: any) {
      captured.commands[name] = opts;
    },
    registerTool() {},
    registerShortcut() {},
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
    setSessionName() {},
    getSessionName() {
      return undefined;
    },
    setLabel() {},
    async exec() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    getActiveTools() {
      return [];
    },
    getAllTools() {
      return [];
    },
    setActiveTools() {},
  };
  return { api, captured };
}

/**
 * Build a git vault with one baseline commit + the expected napkin scaffolding.
 * Returns the absolute vault path.
 */
function createGitVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overlap-integ-vault-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const run = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, env, encoding: "utf-8" });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    }
  };
  run(["init", "-q", "-b", "main"]);
  run(["config", "commit.gpgsign", "false"]);
  run(["config", "user.name", "test"]);
  run(["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(dir, "seed.md"), "# seed\n");
  fs.writeFileSync(
    path.join(dir, ".gitattributes"),
    "*.md merge=napkin-distill-merge\n",
  );
  fs.writeFileSync(
    path.join(dir, ".gitignore"),
    ".napkin/distill/\n.napkin/distill-worktrees/\n",
  );
  fs.mkdirSync(path.join(dir, ".napkin"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".napkin", "config.json"), "{}");
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "seed"]);
  return dir;
}

/**
 * Create a distill worktree against `vault`, commit a modification on the
 * distill branch so `git diff startSha..HEAD` reports at least one file,
 * then write meta.json with `pid: process.pid` so `isPidAlive(pid)` returns
 * true during the test. Returns the worktree path + the file the distill
 * has modified (relative to worktree root).
 */
function createLiveDistillWorkspace(
  vault: string,
  modifiedFile: string,
): { worktreePath: string; branchName: string } {
  // Resolve startSha (main's HEAD) before creating the worktree so meta.json
  // carries the pre-mutation SHA \u2014 diff startSha..HEAD then surfaces the
  // file we're about to modify.
  const headRes = spawnSync("git", ["-C", vault, "rev-parse", "HEAD"], {
    encoding: "utf-8",
  });
  const startSha = headRes.stdout.trim();

  const branchName = `distill/testfx-${Math.floor(Date.now() / 1000)}`;
  const worktreePath = path.join(
    vault,
    ".napkin",
    "distill-worktrees",
    branchName.slice("distill/".length),
  );
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const run = (args: string[], cwd = vault) => {
    const r = spawnSync("git", args, { cwd, env, encoding: "utf-8" });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    }
  };
  run(["-C", vault, "worktree", "add", "-b", branchName, worktreePath, "HEAD"]);

  // Commit a change on the distill branch so diffWorktreeSinceStart reports
  // it. Use a path relative to the worktree.
  const abs = path.join(worktreePath, modifiedFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "---\ntitle: distill\n---\n# modified by distill\n");
  run(["-C", worktreePath, "add", modifiedFile]);
  run(["-C", worktreePath, "commit", "-q", "-m", "distill: test modification"]);

  // Write meta.json so getActiveDistills recognises this worktree. Use the
  // test process's pid \u2014 guaranteed to be alive while the test runs.
  const metaDir = path.join(worktreePath, ".napkin", "distill");
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(
    path.join(metaDir, "meta.json"),
    `${JSON.stringify(
      {
        pid: process.pid,
        vault,
        branch: branchName,
        startedAt: new Date().toISOString(),
        parentSession: "/dev/null",
        startSha,
      },
      null,
      2,
    )}\n`,
  );

  return { worktreePath, branchName };
}

/** Best-effort cleanup of a worktree + its branch. */
function removeWorktree(vault: string, worktreePath: string, branch: string) {
  spawnSync(
    "git",
    ["-C", vault, "worktree", "remove", "--force", worktreePath],
    { encoding: "utf-8" },
  );
  spawnSync("git", ["-C", vault, "worktree", "prune"], { encoding: "utf-8" });
  spawnSync("git", ["-C", vault, "branch", "-D", branch], {
    encoding: "utf-8",
  });
}

/**
 * Build a SessionManager seeded with an assistant message that contains a
 * write-tool call on `pathArg`. Returns the SessionManager so callers can
 * pass it to the handler as `ctx.sessionManager`.
 */
function createSessionWithWrite(dir: string, pathArg: string): SessionManager {
  const sm = SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "please write" });
  // biome-ignore lint/suspicious/noExplicitAny: pi-ai content-block shape
  const msg: any = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "tc1",
        name: "write",
        arguments: { path: pathArg, content: "new content" },
      },
    ],
  };
  sm.appendMessage(msg);
  return sm;
}

describe("before_agent_start handler (integration, G2)", () => {
  let vault: string;
  let sessionDir: string;
  const worktreesToRemove: Array<{ worktreePath: string; branchName: string }> =
    [];

  // Clear the recursion-guard env var \u2014 test runner may be inside a distill
  // subprocess.
  const _savedRecurse = process.env.NAPKIN_DISTILL_NO_RECURSE;
  beforeEach(() => {
    delete process.env.NAPKIN_DISTILL_NO_RECURSE;
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlap-integ-sess-"));
  });

  afterEach(() => {
    if (_savedRecurse !== undefined)
      process.env.NAPKIN_DISTILL_NO_RECURSE = _savedRecurse;
    else delete process.env.NAPKIN_DISTILL_NO_RECURSE;
    for (const w of worktreesToRemove) {
      removeWorktree(vault, w.worktreePath, w.branchName);
    }
    worktreesToRemove.length = 0;
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  /**
   * Call the handler with the given event shape + a ctx that points at
   * `vault`. Returns whatever the handler returned (undefined or
   * `{ systemPrompt }`).
   */
  async function invokeHandler(
    sm: SessionManager,
    event: {
      type: "before_agent_start";
      prompt: string;
      systemPrompt: string;
      // biome-ignore lint/suspicious/noExplicitAny: partial event
      systemPromptOptions: any;
    },
  ): Promise<unknown> {
    const { api, captured } = makeMockAPI();
    distillExtension(api as never);
    // biome-ignore lint/suspicious/noExplicitAny: partial ctx
    const ctx: any = {
      cwd: vault,
      sessionManager: sm,
      hasUI: false,
      ui: null,
    };
    return captured.handlers.before_agent_start(event, ctx);
  }

  function makeEvent(systemPrompt: string) {
    return {
      type: "before_agent_start" as const,
      prompt: "hi",
      systemPrompt,
      systemPromptOptions: {},
    };
  }

  test("overlap exists: returns {systemPrompt: prefix + notice}", async () => {
    const w = createLiveDistillWorkspace(vault, "shared.md");
    worktreesToRemove.push(w);

    // Session wrote the same filename (basename match).
    const sm = createSessionWithWrite(sessionDir, "shared.md");

    const result = (await invokeHandler(
      sm,
      makeEvent("SYSTEM_PROMPT_PREFIX"),
    )) as { systemPrompt: string } | undefined;

    expect(result).toBeDefined();
    expect(result?.systemPrompt).toContain("SYSTEM_PROMPT_PREFIX");
    expect(result?.systemPrompt.length).toBeGreaterThan(
      "SYSTEM_PROMPT_PREFIX".length,
    );
    expect(result?.systemPrompt).toContain("shared.md");
  });

  test("no overlap: handler returns undefined (leaves pi's systemPrompt alone)", async () => {
    const w = createLiveDistillWorkspace(vault, "distill-only.md");
    worktreesToRemove.push(w);
    const sm = createSessionWithWrite(sessionDir, "session-only.md");

    const result = await invokeHandler(sm, makeEvent("PREFIX"));
    expect(result).toBeUndefined();
  });

  test("no active distills: handler returns undefined", async () => {
    // Note: not calling createLiveDistillWorkspace.
    const sm = createSessionWithWrite(sessionDir, "anything.md");
    const result = await invokeHandler(sm, makeEvent("PREFIX"));
    expect(result).toBeUndefined();
  });

  test("NAPKIN_DISTILL_NO_RECURSE set: handler short-circuits even with overlap", async () => {
    const w = createLiveDistillWorkspace(vault, "shared.md");
    worktreesToRemove.push(w);
    const sm = createSessionWithWrite(sessionDir, "shared.md");

    process.env.NAPKIN_DISTILL_NO_RECURSE = "1";
    try {
      const result = await invokeHandler(sm, makeEvent("PREFIX"));
      expect(result).toBeUndefined();
    } finally {
      delete process.env.NAPKIN_DISTILL_NO_RECURSE;
    }
  });

  test("dead distill (pid=99999) filtered out by alive check", async () => {
    // Create a worktree then rewrite meta.json's pid to a likely-dead one.
    const w = createLiveDistillWorkspace(vault, "shared.md");
    worktreesToRemove.push(w);
    const metaPath = path.join(
      w.worktreePath,
      ".napkin",
      "distill",
      "meta.json",
    );
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    meta.pid = 999999; // pid unlikely to be signalable
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    const sm = createSessionWithWrite(sessionDir, "shared.md");
    const result = await invokeHandler(sm, makeEvent("PREFIX"));
    // Dead distill is filtered by alive=false, so no overlap notice.
    expect(result).toBeUndefined();
  });

  test("empty session (no writes): handler returns undefined before touching git", async () => {
    const w = createLiveDistillWorkspace(vault, "shared.md");
    worktreesToRemove.push(w);
    // Plain session with no assistant writes.
    const sm = SessionManager.create(sessionDir, sessionDir);
    sm.appendMessage({ role: "user", content: "hi" });
    const result = await invokeHandler(sm, makeEvent("PREFIX"));
    expect(result).toBeUndefined();
  });

  test("bogus ctx.cwd (Napkin throws): handler returns undefined, no throw", async () => {
    const bogusCwd = fs.mkdtempSync(path.join(os.tmpdir(), "no-vault-"));
    try {
      const { api, captured } = makeMockAPI();
      distillExtension(api as never);
      // biome-ignore lint/suspicious/noExplicitAny: partial ctx
      const ctx: any = {
        cwd: bogusCwd,
        sessionManager: SessionManager.create(bogusCwd, bogusCwd),
        hasUI: false,
        ui: null,
      };
      const result = await captured.handlers.before_agent_start(
        makeEvent("PREFIX"),
        ctx,
      );
      expect(result).toBeUndefined();
    } finally {
      fs.rmSync(bogusCwd, { recursive: true, force: true });
    }
  });
});
