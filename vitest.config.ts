import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The interactive TUI and the process entry point are exercised by
      // humans and e2e smoke tests, not unit tests.
      exclude: ['src/launcher.ts', 'src/index.ts'],
      thresholds: {
        lines: 70,
        branches: 60,
      },
    },
  },
});
