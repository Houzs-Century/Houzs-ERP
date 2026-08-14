import fs from "node:fs/promises";
import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { classifyTests } from "./scripts/lib/classify-tests.mjs";

// The ratcheted areas, from the ONE list the gate also reads. Deriving
// coverage.include from it is what stops the gate auditing a directory vitest
// never instrumented — the failure mode where a shrinking denominator reads as
// a RISING percentage.
import { includeGlobsFor } from "../scripts/coverage-areas.mjs";

// Wires vitest into the Cloudflare Workers runtime. Each test file gets
// its own isolated D1 instance with the same schema as production
// (schema.sql baseline + migrations under src/db/migrations applied at
// suite setup time).
export default defineConfig(async () => {
  // wrangler.toml now carries the [[hyperdrive]] binding (Supabase cutover).
  // Parsing it locally demands an emulation connection string — provide a
  // dummy so config parse succeeds. Tests never connect through it:
  // resolveDatabaseUrl prefers the DATABASE_URL="" pinned below, which keeps
  // the whole suite on the isolated D1.
  process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ??=
    "postgresql://test:test@127.0.0.1:5432/test";
  const migrationsPath = path.join(__dirname, "src/db/migrations");
  const migrations = await readD1Migrations(migrationsPath);
  // schema.sql is the legacy baseline (sales_orders, order_details,
  // etc.) that the numbered migrations assume already exists.
  const baselineSql = await fs.readFile(
    path.join(__dirname, "src/db/schema.sql"),
    "utf8",
  );

  // Baseline + all migrations, pre-collapsed by
  // `npm run gen:test-schema`. tests/setup.ts applies THIS instead of
  // replaying the migration history once per test file; see the long comment
  // there for the measurements. The baseline and migration bindings stay:
  // tests/idempotencyPhase2Migration.test.ts reads TEST_MIGRATIONS, and
  // tests/schemaSnapshotParity.test.ts replays both to prove they agree.
  // Classified from the source tree at config time, not read from a committed
  // list. A committed split is a pure function of the tree, so the only thing a
  // copy of it can add is a chance to be stale — which it was, twice, within a
  // day. See scripts/lib/classify-tests.mjs.
  const testProjects = await classifyTests(__dirname);

  const [schemaSnapshot, schemaSeed] = await Promise.all([
    fs.readFile(
      path.join(__dirname, "tests/generated/test-schema-snapshot.sql"),
      "utf8",
    ),
    fs
      .readFile(
        path.join(__dirname, "tests/generated/test-schema-seed.json"),
        "utf8",
      )
      .then(JSON.parse),
  ]).catch((cause) => {
    throw new Error(
      "tests/generated/ is missing — run `npm run gen:test-schema`",
      { cause },
    );
  });

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // DB_PARITY exists solely for tests/schemaSnapshotParity.test.ts,
          // which replays baseline + migrations into it and asserts the result
          // equals the collapsed snapshot setup.ts applied to DB. It is the
          // proof that the snapshot is not drifting away from the migrations;
          // no other test may touch it. Every test file gets its own isolated
          // instance, and only that one file ever writes to it.
          d1Databases: ["DB", "DB_PARITY"],
          kvNamespaces: ["SESSION_CACHE"],
          bindings: {
            TEST_BASELINE_SQL: baselineSql,
            TEST_MIGRATIONS: migrations,
            TEST_SCHEMA_SNAPSHOT: schemaSnapshot,
            TEST_SCHEMA_SEED: schemaSeed,
            DASHBOARD_API_KEY: "test-dashboard-key",
            // Never inherit a live database URL into the test runtime.
            DATABASE_URL: "",
          },
        },
      }),
    ],
    // Vitest uses Vite to load modules and does NOT read tsconfig "paths", so
    // the @shared/* alias (resolved by esbuild at deploy + tsc at typecheck)
    // must be declared here too, or every suite that imports an scm route
    // fails with "Failed to load url @shared/...".
    resolve: {
      alias: { "@shared": path.resolve(__dirname, "../shared") },
    },
    test: {
      globals: true,
      // ONLY the files that actually reach for the Workers runtime. Everything
      // else runs under vitest.light.config.ts on a plain node runner, because
      // a file that never touches `cloudflare:test` or a D1 binding was paying
      // ~1.76s of workerd startup for nothing — 221 of 265 files were, which
      // is where most of the suite's 565s went. The split used to be a
      // GENERATED manifest (`gen:test-projects` + an `audit:test-projects` gate);
      // it is now classified at load time by `classifyTests` above, so a new
      // test cannot land in the expensive project by omission — there is no
      // list to forget to regenerate. Both scripts and
      // tests/generated/test-projects.json are gone; this comment named them
      // for one merge after they were deleted.
      include: testProjects.workers,
      setupFiles: ["./tests/setup.ts"],
      // The shared workerd module-fetch + D1 migration setup runs in the
      // suite hook; under CI runner contention it can take ~400s, which blew
      // past the previous 30s and flaked EVERY suite at once with an identical
      // "Hook timed out in 30000ms" (0 assertions fail — tests never collect).
      // deploy.yml gates on this, so a flake blocks a prod deploy and forced a
      // manual `gh run rerun --failed` on the #337 deploy. 180s covers the
      // slow cold setup without masking real failures — a genuinely broken
      // test still fails its assertion well under 60s. Local suites run ~7s.
      testTimeout: 60000,
      hookTimeout: 180000,
      // Vitest 4's Cloudflare plugin honours the standard scheduler controls.
      // Keep per-file storage isolation, but execute one file at a time so the
      // workerd coordinator cannot hit the RPC starvation cliff seen in CI.
      fileParallelism: false,
      maxWorkers: 1,
      // ISTANBUL, NOT V8, and that is not a preference: the Workers runtime has
      // no functional `node:inspector`, so the v8 provider cannot collect
      // anything here and the pool refuses it outright with that message.
      //
      // `all: true` is the load-bearing flag. Without it a file no test imports
      // is absent from the report entirely, so the denominator is only the
      // tested files and the percentage reads far higher than the truth. The
      // gate cross-checks the report against the tree and FAILS if a file on
      // disk is missing from it, so turning this off is caught rather than
      // silently rewarded.
      //
      // Enabled only when --coverage is passed; a plain `npm test` pays nothing.
      coverage: {
        provider: "istanbul",
        all: true,
        include: includeGlobsFor("backend", "backend"),
        reporter: ["text-summary", "json"],
        reportsDirectory: "./coverage/workers",
      },
    },
  };
});
