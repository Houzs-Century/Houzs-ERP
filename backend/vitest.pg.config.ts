import { defineConfig } from 'vitest/config';

/** Real PostgreSQL integration suite. Never inherits the Worker/D1 pool. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests-pg/**/*.test.ts', 'tests-node/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
