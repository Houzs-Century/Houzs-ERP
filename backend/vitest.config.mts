import fs from "node:fs/promises";
import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

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

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          d1Databases: ["DB"],
          kvNamespaces: ["SESSION_CACHE"],
          bindings: {
            TEST_BASELINE_SQL: baselineSql,
            TEST_MIGRATIONS: migrations,
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
      setupFiles: ["./tests/setup.ts"],
      // This config has no `include`, so it sweeps up tests-node/** too — which
      // is fine until a file reads from disk. workerd's node:fs shim cannot open
      // a Windows drive path in ANY form: fileURLToPath gives "/C:/…" (ENOENT),
      // the de-slashed "C:/…" is rejected as "must be a file: URL", and a file:
      // URL is converted back to "/C:/…" internally. apportionReceived reads the
      // committed AutoCount snapshot, so it is node-only. It still runs on every
      // PR — vitest.pg.config.ts includes tests-node/** and CI's unconditional
      // backend-postgres job runs `npm run test:pg`.
      exclude: [
        ...configDefaults.exclude,
        "tests-node/apportionReceived.test.ts",
      ],
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
    },
  };
});
