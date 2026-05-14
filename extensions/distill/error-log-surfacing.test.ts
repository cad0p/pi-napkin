/**
 * Unit tests for the wrapper-failure surfacing helpers (R7-SC-3).
 *
 * The wrapper writes forensic logs to
 * `<vault.configPath>/distill/errors/<ISO>-<pid>-<branch-short>.log`
 * on any non-success exit. After a worktree disappears (target gone),
 * `runDistillWith`'s success path checks for a matching log and surfaces
 * the failure to the UI instead of silently calling it a success.
 *
 * Tests focus on `findDistillErrorLogForBranch` (the file-system probe)
 * and `resolveDistillErrorDir` (the layout-aware path resolver). The
 * wiring inside `runDistillWith` is exercised via the existing
 * pollhandle-timeout / shutdown-handler tests when the wrapper's
 * lifecycle is end-to-end.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  findDistillErrorLogForBranch,
  resolveDistillErrorDir,
} from "./distill-workspace";

describe("findDistillErrorLogForBranch (R7-SC-3)", () => {
  let errorDir: string;
  beforeEach(() => {
    errorDir = fs.mkdtempSync(path.join(os.tmpdir(), "find-errlog-"));
  });
  afterEach(() => {
    fs.rmSync(errorDir, { recursive: true, force: true });
  });

  test("error dir doesn't exist: returns null", () => {
    const r = findDistillErrorLogForBranch(
      path.join(errorDir, "no-such-subdir"),
      "abc123-1715198400",
    );
    expect(r).toBeNull();
  });

  test("error dir empty: returns null", () => {
    const r = findDistillErrorLogForBranch(errorDir, "abc123-1715198400");
    expect(r).toBeNull();
  });

  test("empty branchShort: returns null (defensive guard)", () => {
    fs.writeFileSync(path.join(errorDir, "anything.log"), "x");
    const r = findDistillErrorLogForBranch(errorDir, "");
    expect(r).toBeNull();
  });

  test("matching log present: returns absolute path", () => {
    const branchShort = "abc123-1715198400";
    const filename = `2026-05-14T10:00:00Z-12345-${branchShort}.log`;
    const fullPath = path.join(errorDir, filename);
    fs.writeFileSync(fullPath, "# error content");
    const r = findDistillErrorLogForBranch(errorDir, branchShort);
    expect(r).toBe(fullPath);
  });

  test("non-matching log present: returns null (different branch)", () => {
    fs.writeFileSync(
      path.join(errorDir, "2026-05-14T10:00:00Z-12345-other-1715198000.log"),
      "x",
    );
    const r = findDistillErrorLogForBranch(errorDir, "abc123-1715198400");
    expect(r).toBeNull();
  });

  test("multiple matching logs: returns the most recent (lexicographic)", () => {
    const branchShort = "abc123-1715198400";
    fs.writeFileSync(
      path.join(errorDir, `2026-05-14T10:00:00Z-1-${branchShort}.log`),
      "earlier",
    );
    fs.writeFileSync(
      path.join(errorDir, `2026-05-14T10:30:00Z-2-${branchShort}.log`),
      "later",
    );
    const r = findDistillErrorLogForBranch(errorDir, branchShort);
    expect(r).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    expect(fs.readFileSync(r!, "utf-8")).toBe("later");
  });

  test("partial branchShort match in middle of filename: not a match", () => {
    // Suffix matching: the file must END with `-<branchShort>.log`.
    // A branchShort that appears as a substring elsewhere shouldn't hit.
    fs.writeFileSync(
      path.join(errorDir, "abc123-1715198400-something-other.log"),
      "x",
    );
    const r = findDistillErrorLogForBranch(errorDir, "abc123-1715198400");
    expect(r).toBeNull();
  });
});

describe("resolveDistillErrorDir", () => {
  let vault: string;
  let xdgConfigHome: string;
  let savedXdgConfigHome: string | undefined;
  let savedHome: string | undefined;
  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-errdir-"));
    // Isolate from the user's real vault: napkin's `findVault` falls
    // back to `$XDG_CONFIG_HOME/napkin/config.json` (or `$HOME/.config`)
    // when no `.napkin/` exists in the cwd's ancestors. Point both at
    // empty temp dirs so the helper hits its own catch fallback.
    xdgConfigHome = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-xdg-"));
    savedXdgConfigHome = process.env.XDG_CONFIG_HOME;
    savedHome = process.env.HOME;
    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    process.env.HOME = xdgConfigHome;
  });
  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(xdgConfigHome, { recursive: true, force: true });
    if (savedXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  test("vault that doesn't resolve via napkin: falls back to <vault>/.napkin/distill/errors", () => {
    // No napkin config in the dir, no global vault — `new Napkin(vault)`
    // throws. Helper should fall back to the vault-local path.
    const r = resolveDistillErrorDir(vault);
    const expected = path.join(vault, ".napkin", "distill", "errors");
    expect(r).toBe(expected);
  });

  test("returned path is absolute", () => {
    const r = resolveDistillErrorDir(vault);
    expect(path.isAbsolute(r)).toBe(true);
  });
});
