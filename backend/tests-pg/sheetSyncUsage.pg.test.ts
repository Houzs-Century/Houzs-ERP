import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';
import { SHEET_USAGE_REPORT_SQL, usageVerdicts } from '../scripts/lib/sheet-sync-usage-report.mjs';
import { SHEET_USAGE_UPSERT_SQL } from '../src/lib/sheet-sync-usage';
import { assertDisposableTestDatabase } from './lib/doc-no-fixture';

/* The HC Delivery sheet's endpoint counters, against real Postgres.
 *
 * TWO CLAIMS THAT CANNOT BE CHECKED WITHOUT A DATABASE:
 *
 *   1. The upsert the Worker issues really is an upsert — a second call on the
 *      same (endpoint, day) must ADD to the row, not raise a duplicate key and
 *      not overwrite yesterday's count. The whole table is one ON CONFLICT
 *      clause; if it is wrong, the counter silently reports 1 forever.
 *   2. The report's statement runs. It is dispatched by hand, months apart,
 *      from a workflow that only exists once merged — exactly the shape that
 *      ships broken. FILTER aggregates, the date arithmetic and the two-CTE
 *      cross join are all checked here instead.
 *
 * The migration file is located by SUFFIX, never by number: parallel PRs
 * renumber migrations routinely and a number-pinned read would resolve to
 * nothing and pass vacuously. Runs against CI's postgres:16
 * (`npm run test:pg`); SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

/** Apply the real migration file exactly as pg-migrate.mjs does. */
async function applyUsageMigration(sql: Sql): Promise<number> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_scm_sheet_sync_usage.sql'));
  if (files.length !== 1) {
    throw new Error(
      `expected exactly one *_scm_sheet_sync_usage.sql migration, found ${files.length}: ${files.join(', ')}`,
    );
  }
  const stmts = splitSqlStatements(await readFile(join(migrationsDir, files[0]!), 'utf8')) as string[];
  await sql.begin(async (tx) => {
    for (const s of stmts) await tx.unsafe(s);
  });
  return stmts.length;
}

/** The Worker's own upsert, with the D1 `?` placeholders numbered for pg — the
    same rewrite the d1-compat layer does at runtime. */
let placeholder = 0;
const UPSERT_PG = SHEET_USAGE_UPSERT_SQL.replace(/\?/g, () => `$${++placeholder}`);

describePg('scm.sheet_sync_usage — the HC Delivery sheet endpoint counters', () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = postgres(url, { max: 1, prepare: false });
    assertDisposableTestDatabase(url);
    await sql.unsafe('CREATE SCHEMA IF NOT EXISTS scm');
    await sql.unsafe('DROP TABLE IF EXISTS scm.sheet_sync_usage');
    expect(await applyUsageMigration(sql)).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  test('a second call on the same day ADDS to the row rather than conflicting', async () => {
    const ep = 'GET /api/delivery-sheet/so-since';
    await sql.unsafe(UPSERT_PG, [ep, 13, 0]);
    await sql.unsafe(UPSERT_PG, [ep, 7, 1]);

    const [row] = await sql`SELECT calls, rows_out, errors, first_at, last_at FROM scm.sheet_sync_usage WHERE endpoint = ${ep}`;
    expect(Number(row!.calls)).toBe(2);
    expect(Number(row!.rows_out)).toBe(20);
    expect(Number(row!.errors)).toBe(1);
    // first_at is the day's first call and must not move; last_at must.
    expect(new Date(row!.last_at as string).getTime()).toBeGreaterThanOrEqual(
      new Date(row!.first_at as string).getTime(),
    );
  });

  test('the day is the MALAYSIAN day, so the 07:00 MYT triggers do not split across two rows', async () => {
    const [row] = await sql`
      SELECT day = (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS is_myt_today
      FROM scm.sheet_sync_usage LIMIT 1`;
    expect(row!.is_myt_today).toBe(true);
  });

  test('the report SQL runs and measures the windows, the idle gap and the evidence age', async () => {
    // An endpoint last called 45 days ago, inside a table whose evidence goes
    // back 100 days: idle long enough to isolate, not long enough to delete.
    await sql`
      INSERT INTO scm.sheet_sync_usage (endpoint, day, calls, rows_out, errors, first_at, last_at)
      VALUES ('GET /api/delivery-sheet/overdue',
              (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date - 45, 9, 90, 0, now(), now()),
             ('GET /api/delivery-sheet/overdue',
              (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date - 100, 4, 40, 2, now(), now())`;

    const rows = (await sql.unsafe(SHEET_USAGE_REPORT_SQL)) as unknown as Array<Record<string, unknown>>;
    const since = rows.find((r) => r.endpoint === 'GET /api/delivery-sheet/so-since')!;
    const overdue = rows.find((r) => r.endpoint === 'GET /api/delivery-sheet/overdue')!;

    expect(Number(since.calls_7)).toBe(2);
    expect(Number(since.rows_7)).toBe(20);
    expect(Number(since.days_idle)).toBe(0);
    // The 45-day-old row is outside both windows but inside the all-time total.
    expect(Number(overdue.calls_30)).toBe(0);
    expect(Number(overdue.calls_all)).toBe(13);
    expect(Number(overdue.rows_all)).toBe(130);
    expect(Number(overdue.days_idle)).toBe(45);
    expect(Number(overdue.table_age_days)).toBe(100);

    const v = usageVerdicts(rows, Number(overdue.table_age_days));
    expect(v.stale).toEqual(['GET /api/delivery-sheet/overdue']);
    expect(v.dead).toEqual([]);
  });

  test('an endpoint idle longer than the table has existed is NOT reported as idle', async () => {
    const rows = (await sql.unsafe(SHEET_USAGE_REPORT_SQL)) as unknown as Array<Record<string, unknown>>;
    // Same rows, but read as if the table were only 10 days old: silence
    // younger than the evidence proves nothing, so neither verdict may fire.
    const v = usageVerdicts(rows, 10);
    expect(v.stale).toEqual([]);
    expect(v.dead).toEqual([]);
  });
});
