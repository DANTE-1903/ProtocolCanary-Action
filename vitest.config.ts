import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 180_000,
    // #685: testTimeout bounds a single test body, but beforeAll/beforeEach/
    // afterEach/afterAll hooks and worker teardown had no explicit bound and
    // could stall a worker thread in CI before the test timeout ever applied.
    // Both are set above Vitest's 10 s default and below testTimeout so a
    // hanging hook fails with a clear lifecycle error instead of stalling the
    // run, while ordinary suite setup and cleanup still have room to finish.
    hookTimeout: 30_000,
    teardownTimeout: 30_000,
    coverage: {
      provider: "v8",
      // Measure the shipped source, not the committed dist/ bundle or the
      // test suite itself.
      include: ["src/**/*"],
      reportsDirectory: "coverage",
      reporter: ["text", "html", "lcov"],
      // Baseline measured on main (statements 93.98, branches 86.43,
      // functions 97.48, lines 93.85). Each threshold is a fixed 2-point
      // margin below the baseline rounded down so ordinary refactors don't
      // trip it. The numbers should be raised once #357 and #358 merge,
      // not before.
      thresholds: {
        statements: 91,
        branches: 84,
        functions: 95,
        lines: 91,
      },
    },
  },
});
