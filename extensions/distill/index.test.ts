import { expect, test } from "bun:test";

// Smoke test: verifies bun test infrastructure is wired correctly.
// Real tests for distill live alongside their module (e.g.,
// should-distill-on-shutdown.test.ts).
test("bun test infrastructure is green", () => {
  expect(true).toBe(true);
});
