import { env } from "cloudflare:test";
import { beforeAll } from "vitest";

declare module "cloudflare:test" {
  // Surface the test-only bindings so TypeScript stops complaining.
  // All four are injected by vitest.config.mts at pool startup.
  interface ProvidedEnv {
    TEST_BASELINE_SQL: string;
    TEST_MIGRATIONS: import("@cloudflare/vitest-pool-workers").D1Migration[];
    TEST_SCHEMA_SNAPSHOT: string;
    TEST_SCHEMA_SEED: SeedTable[];
    DASHBOARD_API_KEY: string;
  }
}

export interface SeedTable {
  table: string;
  columns: string[];
  rows: (string | number | null)[][];
}

/** Mirrors NOW_SENTINEL in scripts/gen-test-schema-snapshot.mjs. */
export const NOW_SENTINEL = "@@NOW@@";

/**
 * This hook is a vitest `setupFiles` entry, so it runs once per TEST FILE —
 * 277 of them, executed serially (`fileParallelism: false`). Whatever it does
 * is paid 277 times per suite run, and four times over in CI because
 * backend-tests is a 4-shard matrix.
 *
 * It used to rebuild the database from source every time: apply
 * `schema.sql`, then replay all 147 migrations as 1020 individually awaited
 * `prepare().run()` calls, swallowing the "duplicate column" / "already
 * exists" errors thrown by the ones whose effects the baseline already had.
 * That is ~283,000 D1 round-trips for one suite run, the large majority of
 * them statements that were expected to fail. Measured on CI shard 3 of run
 * 31700016666:
 *
 *   Duration 378.84s (transform 6.14s, setup 262.33s, tests 80.80s)
 *
 * Setup was 69% of the job; the tests it existed to serve were 21%. The
 * suite grew from the 112 files the sharding comment in ci.yml was sized
 * against to 277, so this cost scales with BOTH the file count and the
 * migration count — it compounds, which is why CI got slower faster than
 * anyone added tests.
 *
 * Now the baseline and every migration are collapsed ahead of time into
 * `tests/generated/` by `npm run gen:test-schema`, and this hook applies
 * that: one `exec()` for the DDL, one `batch()` for the seed rows. Two
 * round-trips instead of 1021.
 *
 * The generated files are committed and `npm run audit:test-schema` (wired
 * into CI's backend-typecheck job) re-derives them and fails on drift, so a
 * new migration cannot silently leave the suite running against a schema
 * production does not have. `tests/schemaSnapshotParity.test.ts` proves the
 * collapsed schema equals the replayed one inside this same D1.
 */
beforeAll(async () => {
  // Applied the same way the baseline always was: strip the comment header,
  // fold the whole thing onto ONE line, hand it to `exec()`.
  //
  // That shape is load-bearing, not cosmetic. The schema has four triggers
  // whose bodies carry their own semicolons (`... BEGIN UPDATE ...; END`).
  // `prepare()`/`batch()` cannot take those — D1 cuts the statement at the
  // first `;` and rejects the remainder as `incomplete input`. A single-line
  // `exec()` goes to SQLite's multi-statement parser, which knows BEGIN...END
  // is one statement. Do not "tidy" this into one-statement-per-line.
  const ddl = env.TEST_SCHEMA_SNAPSHOT.split("\n")
    .filter((line) => line.trim() && !line.trimStart().startsWith("--"))
    .join(" ");
  await env.DB.exec(ddl);

  // Rows the migrations seeded. `@@NOW@@` marks a column a migration filled
  // with `datetime('now')` — it becomes a live `datetime('now')` here, which
  // is exactly what the per-file replay produced before.
  // One batch per table rather than one for everything: a foreign-key failure
  // then names the table it came from instead of surfacing as a bare
  // "FOREIGN KEY constraint failed" with 315 candidate rows. The generator
  // emits tables parent-first, so this order is the one that satisfies them.
  for (const { table, columns, rows } of env.TEST_SCHEMA_SEED) {
    const quoted = columns.map((c) => `"${c}"`).join(", ");
    const statements = rows.map((row) => {
      const placeholders = row.map((v) =>
        v === NOW_SENTINEL ? "datetime('now')" : "?",
      );
      const bindings = row.filter((v) => v !== NOW_SENTINEL);
      return env.DB.prepare(
        `INSERT INTO "${table}" (${quoted}) VALUES (${placeholders.join(", ")})`,
      ).bind(...bindings);
    });
    if (!statements.length) continue;
    try {
      await env.DB.batch(statements);
    } catch (e: any) {
      throw new Error(
        `Seeding "${table}" (${rows.length} rows) failed: ${e?.message ?? e}`,
        { cause: e },
      );
    }
  }

  // Production's D1 runner creates this tracker before applying files. Phase 2
  // deliberately requires Phase 1 to have soaked for 24 hours, so the clean
  // test database models that precondition instead of bypassing the SQL gate.
  //
  // These two rows are deliberately NOT in the snapshot: they are relative to
  // "now", and freezing them into a committed artifact would pin the soak
  // window to the day the file was generated. The generator inserts them with
  // a frozen stamp so the replay gets past the Phase-2 guard, then deletes
  // them again — they are re-created here, live, exactly as before.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  ).run();
  // Resolved by suffix, never by number: migration numbers here are assigned at
  // merge time against whatever main looks like that minute, so a literal goes
  // stale without anything failing.
  const phase1Name = env.TEST_MIGRATIONS.map((m) => m.name).find((name) =>
    name.endsWith("_idempotency_principal_company_hash.sql"),
  );
  if (!phase1Name) throw new Error("D1 idempotency Phase-1 migration is missing");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR REPLACE INTO _migrations (name, applied_at)
       VALUES (?, datetime('now', '-26 hours'))`,
    ).bind(phase1Name),
    env.DB.prepare(
      `INSERT OR REPLACE INTO app_settings (key, value, updated_at)
       VALUES ('rollout.idempotency_phase1_worker_live', '{"deployed":true}', datetime('now', '-25 hours'))`,
    ),
  ]);
});
