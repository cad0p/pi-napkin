import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// Self-reference import: resolves through the package's own
// `exports` map (`./steering` → `./dist/steering/index.js`),
// exercising the real resolvability contract consumers get — the
// same resolution the steering global config's node_modules uses.
import napkinSteeringPlugin from "@cad0p/pi-napkin/steering";
import gitPlugin from "@cad0p/pi-steering/plugins/git";
import { type Harness, loadHarness } from "@cad0p/pi-steering/testing";
import type {
  BashToolCallEvent,
  ExtensionContext,
  ExecResult as PiExecResult,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";

/**
 * Integration test: the napkin steering plugin wired through
 * pi-steering's engine (`loadHarness` — same pipeline production
 * uses: plugin merge → resolve → evaluator).
 *
 * Coverage matrix:
 *
 *   1. `git commit` inside a napkin vault (real `.napkin/` dir) →
 *      exempted (no block) — the carve-out.
 *   2. Same command outside any vault → blocked (the shipped guard
 *      still fires).
 *   3. Feature-branch commit outside a vault → not blocked (the
 *      rule itself still works — sanity that the carve-out didn't
 *      widen the guard).
 *   4. Dynamic `cd` (walker-unknown cwd) → blocked end-to-end
 *      (strict fail-closed: unknown never exempts).
 *   5. No `exemption-orphan` / error-class diagnostics — the
 *      exemption targets exist in the merged rule universe.
 */

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-napkin-steering-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function bashEvent(command: string): BashToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "t1",
    toolName: "bash",
    input: { command },
  };
}

/**
 * Minimal ExtensionContext in the shape the evaluator consumes
 * (`ctx.cwd` + `sessionManager.getEntries`), mirroring pi-steering's
 * own `makeCtx` test helper. Casts are the same ones pi-steering's
 * tests use.
 */
function makeCtx(cwd: string): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getEntries: () => [],
    } as unknown as ExtensionContext["sessionManager"],
  } as ExtensionContext;
}

/**
 * Exec stub reporting a given branch for `git branch --show-current`
 * (the branch tracker's exec fallback). Every other git call exits 1
 * — the github-flavored rule's `remote:` leaf projects "unknown" →
 * its `onUnknown: "allow"` skips the github rule, and the generic
 * `no-main-commit` decides, exactly like pi-steering's own git
 * integration tests.
 */
function branchExec(branch: string) {
  return async (cmd: string, args: string[]): Promise<PiExecResult> => {
    if (cmd === "git" && args[0] === "branch" && args[1] === "--show-current") {
      return { stdout: `${branch}\n`, stderr: "", code: 0, killed: false };
    }
    return { stdout: "", stderr: "", code: 1, killed: false };
  };
}

function buildHarness(branch: string): Harness {
  return loadHarness({
    config: { plugins: [gitPlugin, napkinSteeringPlugin] },
    host: {
      exec: branchExec(branch),
      appendEntry: () => {},
    },
  });
}

describe("napkin steering plugin — engine wiring", () => {
  test("commit inside a napkin vault is exempted (no block)", async () => {
    const vault = makeTmpDir();
    fs.mkdirSync(path.join(vault, ".napkin"));
    const harness = buildHarness("main");

    const result = await harness.evaluate(
      bashEvent(`cd ${vault} && git commit -m x`),
      makeCtx("/tmp"),
      0,
    );
    expect(result).toBeUndefined();
  });

  test("commit outside any vault on main still blocks", async () => {
    const nonVault = makeTmpDir();
    const harness = buildHarness("main");

    const result = await harness.evaluate(
      bashEvent(`cd ${nonVault} && git commit -m x`),
      makeCtx("/tmp"),
      0,
    );
    expect(result).toBeDefined();
    expect(result?.block).toBe(true);
  });

  test("feature-branch commit outside a vault is not blocked (rule still works)", async () => {
    const nonVault = makeTmpDir();
    const harness = buildHarness("feat/something");

    const result = await harness.evaluate(
      bashEvent(`cd ${nonVault} && git commit -m x`),
      makeCtx("/tmp"),
      0,
    );
    expect(result).toBeUndefined();
  });

  test("dynamic cd (walker-unknown cwd) never exempts — guard fires", async () => {
    const harness = buildHarness("main");

    const result = await harness.evaluate(
      bashEvent('cd "$TARGET" && git commit -m x'),
      makeCtx("/tmp"),
      0,
    );
    // Fail-closed composition: unknown cwd → `isNapkinVault` returns
    // the "unknown" sentinel → exemption does not match → the rule's
    // own `onUnknown` policy (block) decides.
    expect(result).toBeDefined();
    expect(result?.block).toBe(true);
  });

  test("dynamic cd with a vault as ambient cwd still blocks (no fallback-to-ambient regression)", async () => {
    // Pins the fail-closed property against a hypothetical walker
    // regression that falls back to the ambient session cwd on
    // dynamic `cd`: with a real vault as ambient cwd, such a
    // fallback would exempt the commit and fail OPEN. The walker
    // today resolves `cd "$TARGET"` to the "unknown" sentinel, so
    // the exemption does not match and the guard fires.
    const vault = makeTmpDir();
    fs.mkdirSync(path.join(vault, ".napkin"));
    const harness = buildHarness("main");

    const result = await harness.evaluate(
      bashEvent('cd "$TARGET" && git commit -m x'),
      makeCtx(vault),
      0,
    );
    expect(result).toBeDefined();
    expect(result?.block).toBe(true);
  });

  test("no exemption-orphan or error-class diagnostics (targets exist)", () => {
    const harness = buildHarness("main");
    const problems = harness.diagnostics.filter(
      (d) =>
        d.type === "error" || ("kind" in d && d.kind === "exemption-orphan"),
    );
    expect(problems).toEqual([]);
  });
});
