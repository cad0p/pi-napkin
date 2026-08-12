import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PredicateContext } from "@cad0p/pi-steering";
import { afterEach, describe, expect, test } from "vitest";
import {
  isNapkinVault,
  isNapkinVaultDir,
  NAPKIN_MARKER,
} from "./predicates.ts";

/**
 * Unit tests for the read-only napkin-vault walk + `isNapkinVault`
 * predicate handler.
 *
 * All directory fixtures are real mkdtemp trees (mirroring the
 * repo's tmpdir conventions) so the walk's fs probes
 * (`existsSync` + `statSync().isDirectory()`) run against reality,
 * including the marker-is-a-FILE case that only real paths can
 * exercise.
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

describe("isNapkinVaultDir (read-only walk-up)", () => {
  test("resolves a .napkin/ marker at the vault root, from root and from a nested subdir", () => {
    const vault = makeTmpDir();
    fs.mkdirSync(path.join(vault, NAPKIN_MARKER));
    const nested = path.join(vault, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });

    expect(isNapkinVaultDir(vault)).toBe(vault);
    expect(isNapkinVaultDir(nested)).toBe(vault);
  });

  test("resolves the nested .obsidian/.napkin/ layout, from root and from a subdir", () => {
    const vault = makeTmpDir();
    fs.mkdirSync(path.join(vault, ".obsidian", NAPKIN_MARKER), {
      recursive: true,
    });
    const nested = path.join(vault, "notes", "deep");
    fs.mkdirSync(nested, { recursive: true });

    expect(isNapkinVaultDir(vault)).toBe(vault);
    expect(isNapkinVaultDir(nested)).toBe(vault);
  });

  test("returns null for a non-vault tree (no markers anywhere)", () => {
    const tree = makeTmpDir();
    const nested = path.join(tree, "x", "y");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "notes.md"), "# hi");

    expect(isNapkinVaultDir(tree)).toBeNull();
    expect(isNapkinVaultDir(nested)).toBeNull();
  });

  test("a FILE named .napkin is not a vault (isDirectory guard, mirrors napkin)", () => {
    const vault = makeTmpDir();
    fs.writeFileSync(path.join(vault, NAPKIN_MARKER), "not a dir");
    const nested = path.join(vault, "sub");
    fs.mkdirSync(nested);

    expect(isNapkinVaultDir(vault)).toBeNull();
    expect(isNapkinVaultDir(nested)).toBeNull();
  });

  test("walking from the filesystem root terminates with null (no infinite loop)", () => {
    expect(isNapkinVaultDir(path.parse(process.cwd()).root)).toBeNull();
  });

  test("a failed walk writes NOTHING (no .napkin/ created anywhere)", () => {
    const parent = makeTmpDir();
    const cwd = path.join(parent, "deep", "tree");
    fs.mkdirSync(cwd, { recursive: true });

    const before = fs.readdirSync(parent).sort();
    expect(isNapkinVaultDir(cwd)).toBeNull();
    const after = fs.readdirSync(parent).sort();

    expect(after).toEqual(before);
    expect(fs.existsSync(path.join(cwd, NAPKIN_MARKER))).toBe(false);
  });
});

describe("isNapkinVault handler", () => {
  function ctxWith(cwd: string): PredicateContext {
    return { cwd } as PredicateContext;
  }

  test("true + vault cwd → true", () => {
    const vault = makeTmpDir();
    fs.mkdirSync(path.join(vault, NAPKIN_MARKER));
    expect(isNapkinVault(true, ctxWith(vault))).toBe(true);
  });

  test("true + non-vault cwd → false", () => {
    const nonVault = makeTmpDir();
    expect(isNapkinVault(true, ctxWith(nonVault))).toBe(false);
  });

  test("true + unknown cwd → 'unknown' sentinel (fail-closed trinary, not 'not a vault')", () => {
    expect(isNapkinVault(true, ctxWith("unknown"))).toBe("unknown");
  });

  test("non-true args → false (spread form / stray values never match)", () => {
    const vault = makeTmpDir();
    fs.mkdirSync(path.join(vault, NAPKIN_MARKER));
    expect(isNapkinVault(false, ctxWith(vault))).toBe(false);
    expect(isNapkinVault(undefined, ctxWith(vault))).toBe(false);
    expect(isNapkinVault({ value: true }, ctxWith(vault))).toBe(false);
  });
});
