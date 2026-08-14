import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PredicateContext } from "@cad0p/pi-steering";
import { afterEach, describe, expect, test } from "vitest";
import { isNapkinVault } from "./predicates.ts";

/**
 * Unit tests for the `isNapkinVault` predicate handler. The vault
 * walk itself is napkin-owned: `isNapkinVaultDir` is an alias for
 * napkin's `findAncestorVault`, so these fixtures exercise the real
 * walk through the handler (the alias is a one-line binding — the
 * walk's own tests live in napkin).
 *
 * All directory fixtures are real mkdtemp trees (mirroring the
 * repo's tmpdir conventions) so the handler's fs probes run against
 * reality.
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

describe("isNapkinVault handler", () => {
  function ctxWith(cwd: string): PredicateContext {
    return { cwd } as PredicateContext;
  }

  test("true + vault cwd → true", () => {
    const vault = makeTmpDir();
    fs.mkdirSync(path.join(vault, ".napkin"));
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
    fs.mkdirSync(path.join(vault, ".napkin"));
    expect(isNapkinVault(false, ctxWith(vault))).toBe(false);
    expect(isNapkinVault(undefined, ctxWith(vault))).toBe(false);
    expect(isNapkinVault({ value: true }, ctxWith(vault))).toBe(false);
  });
});
