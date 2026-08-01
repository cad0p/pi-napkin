import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Napkin } from "@cad0p/napkin";
import { afterEach, describe, expect, test } from "vitest";

/**
 * Smoke test for the in-process search path that `napkin-context`'s
 * `kb_search` tool calls (`new Napkin(...)` → `n.search(query)`).
 *
 * Purpose:
 *   1. **Dependency-pickup gate.** Guards the bump of `@cad0p/napkin`
 *      (currently 0.8.1 → 0.10.0): the search *public API* used by the
 *      extension (`search(query)` returning `{file, snippets}` entries)
 *      must keep working against the new napkin.
 *   2. **Latency smoke.** The napkin 0.10 search rewrite targets ≤5s on
 *      large vaults; on a small synthetic vault we assert cold search
 *      stays well under a generous ceiling so a regression from an
 *      extreme perf cliff (e.g. the old O(n²) backlink walk) is caught
 *      on CI without flaking under load.
 *
 * The vault is a real `napkin init` vault (invokes the `napkin` CLI
 * from node_modules/.bin like `scripts/verify-e2e.ts` does), then the
 * in-process SDK is used — matching the extension's runtime exactly.
 */

const _here = path.dirname(fileURLToPath(import.meta.url));
const NAPKIN_BIN = path.resolve(
  _here,
  "..",
  "..",
  "node_modules",
  ".bin",
  "napkin",
);

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Create a real vault with `napkin init` + N note files under notes/. */
function createVault(noteCount: number): string {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-smoke-"));
  tempDirs.push(vault);

  const init = spawnSync(NAPKIN_BIN, ["init", "--path", vault], {
    encoding: "utf-8",
  });
  expect(init.status, `napkin init failed: ${init.stderr}`).toBe(0);

  const notesDir = path.join(vault, "notes");
  fs.mkdirSync(notesDir, { recursive: true });
  for (let i = 0; i < noteCount; i++) {
    const unique = `gizmo-${i}`;
    fs.writeFileSync(
      path.join(notesDir, `${unique}.md`),
      `# ${unique}\n\nA note about the ${unique} widget and its frobnicator.\n`,
    );
  }
  // A distinctive note only findable by content (not basename amply)
  fs.writeFileSync(
    path.join(notesDir, "manual.md"),
    "The kelpForrest harvesting procedure is documented here.\n",
  );

  return vault;
}

describe("napkin-context in-process search (dependency smoke)", () => {
  test("search returns ranked results with file + snippets (API contract)", () => {
    const vault = createVault(25);
    const n = new Napkin(vault);

    // Basename hit
    const byName = n.search("gizmo-7");
    expect(byName.length).toBeGreaterThan(0);
    expect(byName[0].file).toContain("gizmo-7.md");

    // Content-only hit (the napkin 0.10 rewrite must not regress recall):
    // "kelpForrest" exists only in manual.md body, not in any basename.
    const byContent = n.search("kelpForrest");
    expect(byContent.length).toBeGreaterThan(0);
    expect(byContent.some((r) => r.file.endsWith("manual.md"))).toBe(true);
    expect(byContent[0].snippets).toBeDefined();

    // Content scan is case-insensitive (substring scan, non-word-boundary).
    const byCaseInsensitive = n.search("KELPFORREST");
    expect(byCaseInsensitive.length).toBeGreaterThan(0);
  });

  test("cold search on a 250-note vault is fast (perf regression guard)", () => {
    const vault = createVault(250);
    const n = new Napkin(vault);
    const start = performance.now();
    const results = n.search("gizmo");
    const elapsedMs = performance.now() - start;

    expect(results.length).toBeGreaterThan(0);
    // Generous ceiling: the old full-content MiniSearch indexing took
    // seconds on large vaults; 0.10 hardens §≤5s. CI runners are slower
    // than dev boxes, so a 2s bound catches order-of-magnitude cliffs
    // without flaking.
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
