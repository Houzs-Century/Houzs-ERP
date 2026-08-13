import path from "node:path";
import { defineConfig } from "vitest/config";
import { classifyTests } from "./scripts/lib/classify-tests.mjs";

// The backend's pure-logic suite, on a plain node runner.
//
// These are the same tests that used to run inside the Workers pool. Nothing
// about them changed — they simply never referenced `cloudflare:test` or a D1
// binding, so the workerd instance and isolated database booted for each of
// them was doing no work. `vitest.config.mts` runs files one at a time
// (the pool collapses above that), so that startup was serial and it
// dominated everything: the full suite measured 2026-08-13 at
// `565s, of which setup is 490s and the tests themselves are 10.9s`.
//
// The same 221 files here: **6.09s, 3433 tests, green.**
//
// Membership is computed from the source tree every run — see
// scripts/lib/classify-tests.mjs for why this is not a committed list.
//
// No setupFiles: the schema snapshot exists to give a test a database, and by
// construction nothing in this project has one.
export default defineConfig(async () => {
  const testProjects = await classifyTests(__dirname);

  return {
    // Vitest does not read tsconfig "paths"; the alias has to be repeated here
    // for the same reason vitest.config.mts repeats it.
    resolve: {
      alias: { "@shared": path.resolve(__dirname, "../shared") },
    },
    test: {
      globals: true,
      environment: "node",
      include: testProjects.light,
    },
  };
});
