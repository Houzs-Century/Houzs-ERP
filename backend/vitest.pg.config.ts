import { defineConfig } from 'vitest/config';
import { PDF_SHARED_ALIASES } from './scripts/lib/pdf-shared-aliases.mjs';

/** Real PostgreSQL integration suite. Never inherits the Worker/D1 pool. */
export default defineConfig({
  // Suites that import the app reach the AI Connector's get_pdf, which bundles the
  // frontend layout code (src/lib/shared-pdf.ts): same bare names as wrangler.toml [alias].
  resolve: { alias: PDF_SHARED_ALIASES },
  test: {
    environment: 'node',
    include: ['tests-pg/**/*.test.ts', 'tests-node/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
