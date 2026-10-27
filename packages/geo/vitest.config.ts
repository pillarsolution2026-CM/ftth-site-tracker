import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Property tests run 10,000 cases each (plan); the arc one takes ~3 s alone and
    // overran the 5 s default when turbo runs every package's tests in parallel.
    testTimeout: 60_000,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/index.ts'],
      // Plan: ≥ 90% coverage for geometry logic.
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
