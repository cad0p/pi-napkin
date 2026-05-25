/**
 * Unit tests for `scripts/verify-e2e.ts` helpers that govern `--all`
 * cost discipline. The cheapest-first ordering invariant lives here
 * (and not in the gate run itself) because mutations like a sign-flip
 * in the comparator or a dropped predicate still GREEN the gate at
 * a wall cost of ~$0.50 per LLM variant. A failing unit test catches
 * the regression at `bun test` cost.
 *
 * `bun test` discovers `scripts/*.test.ts` independently of tsconfig's
 * include surface, so this file runs as part of the regular suite.
 * Importing from `verify-e2e.ts` is side-effect-free thanks to the
 * `import.meta.main` guard around `main()`.
 */
import { describe, expect, it } from "bun:test";

import {
  isAbortVariant,
  orderVariantsForAll,
  VARIANTS,
  type Variant,
} from "./verify-e2e";

describe("orderVariantsForAll", () => {
  it("places every abort variant before every non-abort variant", () => {
    const ordered = orderVariantsForAll(VARIANTS);
    const firstNonAbortIdx = ordered.findIndex((v) => !isAbortVariant(v));
    const lastAbortIdx = ordered.findLastIndex(isAbortVariant);
    // Both kinds exist in the current tuple; if a future change
    // collapses to one kind only, the assertion below is vacuous
    // (one of the indexes is -1) and the test should still pass.
    if (firstNonAbortIdx !== -1 && lastAbortIdx !== -1) {
      expect(lastAbortIdx).toBeLessThan(firstNonAbortIdx);
    }
  });

  it("first element is abort-class for the current VARIANTS tuple", () => {
    const ordered = orderVariantsForAll(VARIANTS);
    expect(ordered.length).toBeGreaterThan(0);
    expect(isAbortVariant(ordered[0]!)).toBe(true);
  });

  it("preserves intra-band tuple order (stable sort)", () => {
    // VARIANTS = ["healthy", "config-outside-block", "orphaned-worktree"].
    // Exactly one abort variant ("config-outside-block"); the other two
    // are non-abort. Stable sort puts the abort variant first, then the
    // non-abort variants in their original tuple order. Snapshot pins
    // the deterministic output so a sign-flip OR a dropped predicate
    // (no-op sort that preserves tuple order, putting "healthy" first)
    // both fail this test.
    const ordered = orderVariantsForAll(VARIANTS);
    expect(ordered).toEqual([
      "config-outside-block",
      "healthy",
      "orphaned-worktree",
    ]);
  });

  it("does not mutate the input tuple", () => {
    // The helper returns a new array; the input must be untouched so
    // VARIANTS (a readonly tuple at the type level, but a real array
    // at runtime) keeps its definition order for other consumers
    // (e.g. parseArgs's --variant validation).
    const before: readonly Variant[] = [...VARIANTS];
    orderVariantsForAll(VARIANTS);
    expect([...VARIANTS]).toEqual([...before]);
  });
});
