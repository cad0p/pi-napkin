import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Mirror the old `bun test` discovery surface: every *.test.ts under
    // extensions/ and scripts/. tsx resolves extensionless TS imports.
    include: ["extensions/**/*.test.ts", "scripts/**/*.test.ts"],
    // Default pool (forks) runs each test file in its own process in
    // parallel. Tests that scan `os.tmpdir()` for `napkin-distill-*`
    // entries (routing.test.ts, health-check-wiring.test.ts) redirect
    // `TMPDIR` per-test in beforeEach, isolating them from sibling files'
    // entries. Tests within a file still run sequentially by default.
    // Tests that need more (the polling / wrapper-invariant suites) pass
    // an explicit positional timeout to `test()`/`it()`, which vitest
    // honors identically.
    testTimeout: 5_000,
  },
});
