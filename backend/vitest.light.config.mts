import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

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
// Membership is NOT hand-maintained. `npm run gen:test-projects` classifies
// every backend test by whether it reaches for the Workers runtime, and
// `npm run audit:test-projects` fails CI when the split is stale — a new test
// file landing in the wrong project is otherwise invisible, and the only
// symptom is the suite gradually becoming slow again.
//
// No setupFiles: the schema snapshot exists to give a test a database, and by
// construction nothing in this project has one.
const testProjects = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "tests/generated/test-projects.json"),
    "utf8",
  ),
);

export default defineConfig({
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
});
