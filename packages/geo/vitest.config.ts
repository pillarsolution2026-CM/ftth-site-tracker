import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/index.ts'],
      // Plan: ≥ 90% coverage for geometry logic.
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
