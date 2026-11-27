/**
 * Operator entry point for the distill-worktree sweep.
 *
 * Skipped unless NAPKIN_SWEEP_VAULT points at a vault content root, so the
 * normal suite is unaffected. Prints the sweep decision as JSON; deletes
 * nothing unless NAPKIN_SWEEP_APPLY=1. The decision logic is the shipped
 * sweepStaleWorktrees(), not a copy of it.
 *
 *   NAPKIN_SWEEP_VAULT=/path/to/vault npx vitest run scripts/sweep-distill-worktrees.test.ts
 *   NAPKIN_SWEEP_VAULT=/path/to/vault NAPKIN_SWEEP_APPLY=1 npx vitest run scripts/sweep-distill-worktrees.test.ts
 */
import { spawnSync } from "node:child_process";
import { test } from "vitest";
import { sweepStaleWorktrees } from "../extensions/distill/distill-workspace";

const vault = process.env.NAPKIN_SWEEP_VAULT;
const apply = process.env.NAPKIN_SWEEP_APPLY === "1";

test.skipIf(!vault)("napkin distill sweep (operator entry point)", () => {
  const result = sweepStaleWorktrees(
    { contentPath: vault as string },
    { dryRun: !apply },
  );
  const bytes = result.removedPaths.reduce((sum, p) => {
    const du = spawnSync("du", ["-sb", p], { encoding: "utf-8" });
    return sum + (Number.parseInt(du.stdout.split("\t")[0] ?? "0", 10) || 0);
  }, 0);
  process.stdout.write(
    `${JSON.stringify({ applied: apply, removed: result.removed, bytes, removedPaths: result.removedPaths, kept: result.kept }, null, 2)}\n`,
  );
});
