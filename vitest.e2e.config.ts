import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    // Each test spawns the built CLI as a subprocess.
    testTimeout: 30_000,
  },
});
