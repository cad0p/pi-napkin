import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Mirror the old `bun test` discovery surface: every *.test.ts under
    // extensions/ and scripts/. tsx resolves extensionless TS imports.
    include: ["extensions/**/*.test.ts", "scripts/**/*.test.ts"],
    // bun:test ran files sequentially; several tests scan os.tmpdir()
    // for `napkin-distill-*` entries and assume no other test file is
    // creating/cleaning such entries concurrently. Run files in a single
    // thread to preserve that isolation assumption (tests within a file
    // still run sequentially by default).
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    // Tests that need more (the polling / wrapper-invariant suites) pass
    // an explicit positional timeout to `test()`/`it()`, which vitest
    // honors identically.
    testTimeout: 5_000,
  },
});
