/* EXECUTES every query behind `scripts/probe-undated-demand.mjs` against real
 * Postgres. Not a shape test, not a regex over the source — the statements run.
 *
 * WHY THIS EXISTS, precisely. The probe shipped with its SQL never executed:
 * there is no local database, and a `workflow_dispatch` workflow cannot be
 * dispatched until it is on the default branch, so "node --check passes" was
 * the only evidence it had. On its first production dispatch (run 31962771658,
 * 2026-08-16) it died mid-run:
 *
 *     FAIL subquery uses ungrouped column "h.created_at" from outer query
 *
 * A correlated subquery beside a GROUP BY referenced the raw `h.created_at`
 * that the grouping had already collapsed into `date_trunc('month', ...)`.
 * That cost company 2's answer entirely — the loop had not reached it — plus a
 * second dispatch of the owner's time.
 *
 * `node --check` cannot see it, typecheck cannot see it, and vitest's Worker
 * pool has no Postgres. Only Postgres can parse Postgres. CI already runs one
 * (the `backend-postgres` job's postgres:16 service), so the queries now live
 * in ONE home — `scripts/lib/undated-demand-queries.mjs` — and this suite runs
 * every exported one of them. The probe imports the same module, so there is no
 * second copy to drift.
 *
 * SKIPPED, not failed, without TEST_DATABASE_URL, matching the other pg suites.
 */
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Q from '../scripts/lib/undated-demand-queries.mjs';

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

let sql: Sql;

/* The columns these queries touch, and nothing else. A fixture that mirrored the
   whole SO header would rot against it; this one states exactly what the SQL
   depends on, so a column this probe needs going missing shows up HERE. */
async function schema(db: Sql) {
  await db.unsafe(`
    DROP SCHEMA IF EXISTS scm CASCADE;
    CREATE SCHEMA scm;
    CREATE TABLE IF NOT EXISTS public.users (id uuid PRIMARY KEY, email text);
    CREATE TABLE scm.mfg_sales_orders (
      doc_no text PRIMARY KEY, company_id int, status text,
      customer_delivery_date date, processing_date date, proceeded_at date,
      target_date date, linked_ac_docno text,
      created_at timestamptz, updated_at timestamptz, created_by uuid
    );
    CREATE TABLE scm.mfg_sales_order_items (
      id serial PRIMARY KEY, doc_no text, cancelled boolean, qty numeric,
      line_delivery_date date
    );
  `);
}

/* A fixture with the shape production actually has: a bulk import (undated,
   CONFIRMED, HC- doc numbers, no creator) plus ERP-born orders, one of which is
   a refused-pair row, and — for company 2 — one header whose LINE carries the
   date the header lacks, so C(c)'s "some_line_dated" is proved non-vacuous. */
async function seed(db: Sql) {
  await db.unsafe(`
    -- ON CONFLICT, not DROP: public.users is shared with the other pg suites, and
    -- the schema drop above does not reach it — so a second run against the same
    -- database (a local one; CI's service container is fresh) must not collide.
    INSERT INTO public.users VALUES ('11111111-1111-1111-1111-111111111111','sales@houzs.test')
      ON CONFLICT (id) DO NOTHING;

    INSERT INTO scm.mfg_sales_orders
      (doc_no, company_id, status, customer_delivery_date, processing_date, linked_ac_docno, created_at, updated_at, created_by) VALUES
      -- company 1: the import — undated, CONFIRMED, HC-, no creator
      ('HC-SO-000001', 1, 'CONFIRMED', NULL,         NULL,         'SO-000001', now() - interval '3 days', now() - interval '3 days', NULL),
      ('HC-SO-000002', 1, 'CONFIRMED', NULL,         NULL,         'SO-000002', now() - interval '3 days', now() - interval '3 days', NULL),
      -- company 1: ERP-born, properly dated
      ('SO-2608-001',  1, 'CONFIRMED', DATE '2026-10-01', NULL,    NULL,        now() - interval '1 day',  now() - interval '1 day',  '11111111-1111-1111-1111-111111111111'),
      -- company 1: ERP-born REFUSED PAIR (processing date, no delivery date)
      ('SO-2608-002',  1, 'CONFIRMED', NULL,         DATE '2026-09-01', NULL,   now() - interval '1 day',  now(),                     '11111111-1111-1111-1111-111111111111'),
      -- company 1: terminal, must be EXCLUDED from every "live" figure
      ('SO-2608-DONE', 1, 'DELIVERED', NULL,         NULL,         NULL,        now() - interval '9 days', now() - interval '9 days', NULL),
      -- company 1: NULL status — the idiom keeps it live rather than dropping it
      ('SO-2608-NUL',  1, NULL,        NULL,         NULL,         NULL,        now() - interval '2 days', now() - interval '2 days', NULL),
      -- company 2: undated header whose LINE carries a date
      ('2990-SO-001',  2, 'CONFIRMED', NULL,         NULL,         NULL,        now() - interval '2 days', now() - interval '2 days', NULL),
      ('2990-SO-002',  2, 'CONFIRMED', DATE '2026-10-01', NULL,    NULL,        now() - interval '2 days', now() - interval '2 days', NULL);

    INSERT INTO scm.mfg_sales_order_items (doc_no, cancelled, qty, line_delivery_date) VALUES
      ('HC-SO-000001', false, 3, NULL),
      ('HC-SO-000002', false, 2, NULL),
      ('SO-2608-001',  false, 1, DATE '2026-10-01'),
      ('SO-2608-002',  false, 1, NULL),
      ('SO-2608-DONE', false, 5, NULL),
      ('SO-2608-NUL',  false, 1, NULL),
      ('SO-2608-001',  true,  9, NULL),   -- cancelled: must not count
      ('SO-2608-001',  false, 0, NULL),   -- zero qty: must not count
      ('2990-SO-001',  false, 4, DATE '2026-11-01'),
      ('2990-SO-002',  false, 1, DATE '2026-10-01');
  `);
}

describePg('probe-undated-demand SQL — every statement runs on real Postgres', () => {
  beforeAll(async () => {
    sql = postgres(url, { max: 1, prepare: false });
    await schema(sql);
    await seed(sql);
  });
  afterAll(async () => { await sql?.end({ timeout: 5 }); });

  /* THE REGRESSION. This is the statement that killed run 31962771658. It is
     first because it is the reason the suite exists: if the correlated-subquery
     form ever comes back, this fails here instead of in front of the owner. */
  test('byMonth executes — the ungrouped-column crash of run 31962771658', async () => {
    const rows = await Q.byMonth(sql, 1);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0]).toHaveProperty('mon');
    expect(rows[0]).toHaveProperty('undated');
    expect(rows[0]).toHaveProperty('live_that_month');
  });

  test('every exported query executes without throwing', async () => {
    // Enumerated from the module itself, so a query added there without a test
    // cannot slip past: the loop finds it.
    const skip = new Set(['hasColumn']);
    const names = Object.keys(Q).filter((k) => typeof (Q as never)[k] === 'function' && !skip.has(k));
    expect(names.length).toBeGreaterThan(10);
    for (const n of names) {
      const fn = (Q as unknown as Record<string, (...a: unknown[]) => Promise<unknown[]>>)[n]!;
      // hasAc / named are booleans on the arity-3 queries; both arms are covered
      // by the two passes below.
      for (const flag of [true, false]) {
        const rows = await fn(sql, 1, flag);
        expect(Array.isArray(rows), `${n} (flag=${flag}) returned a non-array`).toBe(true);
      }
    }
  });

  test('hasColumn answers truthfully in both directions', async () => {
    expect((await Q.hasColumn(sql, 'scm', 'mfg_sales_orders', 'linked_ac_docno'))[0]!.n).toBe(1);
    expect((await Q.hasColumn(sql, 'scm', 'mfg_sales_orders', 'no_such_column'))[0]!.n).toBe(0);
  });

  /* The figures, not just the execution — a query that runs and answers the
     wrong question is the trap CLAUDE.md names. */
  test('live excludes terminal orders, cancelled lines and zero-qty lines', async () => {
    const [lines] = await Q.liveLines(sql, 1);
    // Live lines: HC-1, HC-2, SO-001(dated), SO-002, SO-NUL = 5.
    // DELIVERED is terminal; the cancelled and zero-qty lines drop out.
    expect(lines!.live).toBe(5);
    // Undated of those: HC-1, HC-2, SO-002, SO-NUL = 4 (SO-001 carries a date).
    expect(lines!.undated).toBe(4);
  });

  test('C(c) separates MISSING from MISPLACED, and is not vacuously zero', async () => {
    // Company 2 has exactly one header with no date whose LINE carries one.
    const [c2] = await Q.lineVsHeader(sql, 2);
    expect(c2!.some_line_dated).toBe(1);
    expect(c2!.no_line_dated).toBe(0);
    // Company 1's undated headers have no dated lines either — genuinely missing.
    const [c1] = await Q.lineVsHeader(sql, 1);
    expect(c1!.some_line_dated).toBe(0);
  });

  test('the refused pair is found and NAMED', async () => {
    const [xor] = await Q.undatedXor(sql, 1);
    expect(xor!.with_proc).toBe(1);
    const rows = await Q.refusedPairRows(sql, 1, true);
    expect(rows.map((r) => (r as { doc_no: string }).doc_no)).toEqual(['SO-2608-002']);
    // ERP-born, so the cutover importer cannot explain it — that is the point.
    expect((rows[0] as { linked_ac_docno: string | null }).linked_ac_docno).toBeNull();
  });

  test('D separates the import from ERP-born, on BOTH fingerprints', async () => {
    const [imp] = await Q.importedVsErpBorn(sql, 1);
    expect(imp!.undated).toBe(4);      // HC-1, HC-2, SO-002, SO-NUL
    expect(imp!.by_ac_col).toBe(2);    // the two HC- rows carry linked_ac_docno
    expect(imp!.by_docno).toBe(2);     // and the same two match 'HC-%'
    expect(imp!.erp_born).toBe(2);     // SO-2608-002 and SO-2608-NUL
  });

  test('E can distinguish "still produced by the ERP" from "one old import"', async () => {
    const [r] = await Q.stillProduced(sql, 1, true);
    expect(r!.d7).toBe(4);        // everything undated was seeded inside 7 days
    expect(r!.d7_erp).toBe(2);    // but only two of them are ERP-born
  });

  test('a NULL-status header stays LIVE rather than being silently dropped', async () => {
    // The repo idiom is UPPER(COALESCE(status::text,'')), which keeps it. A row
    // nobody can classify is a row somebody should look at.
    const rows = await Q.byStatus(sql, 1);
    expect(rows.map((r) => (r as { status: string }).status)).toContain('(null)');
  });
});
