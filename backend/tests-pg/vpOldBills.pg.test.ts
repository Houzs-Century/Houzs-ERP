import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';
import { assertDisposableTestDatabase } from './lib/doc-no-fixture';

/* EXECUTES the order feed's old-order SQL (migration *_scm_vp_old_bills.sql)
 * against real Postgres: which orders dated before vp.since the drain sends
 * (scm.vp_old_orders_wanted), the two keys the portal decides them by
 * (salesperson.active, payments[].collected_by_name), and the reconcile
 * finding the ones that never reached the portal.
 *
 * The portal pays the colleague who collected the top-up of a departed
 * salesperson's order that was under its deposit when it started paying
 * (owner 2026-11-07). The fixture is HC-SO-010734 as production holds it:
 * paper ZNT4813, sold 2026-03-10 by a salesperson who has left, RM 800
 * deposit, RM 3,200 collected by a colleague on 2026-11-02, a sent row from
 * the first backfill (2026-09-13) and only skipped rows after it. People are
 * stand-ins.
 *
 * Migration files are located by SUFFIX, never by number: parallel PRs
 * renumber migrations. Runs against CI's postgres:16 (`npm run test:pg`);
 * SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

type Obj = { [k: string]: unknown };

let sql: Sql;

async function applyMigration(s: Sql, suffix: string): Promise<number> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(suffix));
  if (files.length !== 1) {
    throw new Error(`expected exactly one *${suffix} migration, found ${files.length}: ${files.join(', ')}`);
  }
  const stmts = splitSqlStatements(await readFile(join(migrationsDir, files[0]!), 'utf8')) as string[];
  await s.begin(async (tx) => { for (const st of stmts) await tx.unsafe(st); });
  return stmts.length;
}

/* Dropped before AND after: every suite in this directory shares houzs_test. */
const DROP_FIXTURE = `
  DROP TABLE IF EXISTS public.projects, public.project_event_types CASCADE;
  DROP VIEW IF EXISTS scm.mfg_sales_orders_with_payment_totals CASCADE;
  DROP TABLE IF EXISTS scm.mfg_sales_orders, scm.staff, scm.mfg_sales_order_items,
    scm.mfg_sales_order_payments, scm.venture_portal_outbox CASCADE;
  DROP FUNCTION IF EXISTS scm.vp_build_payloads(text[]) CASCADE;
  DROP FUNCTION IF EXISTS scm.vp_requeue_undelivered(bigint[], date, boolean) CASCADE;
  DROP FUNCTION IF EXISTS scm.vp_old_orders_wanted(text[], date) CASCADE;
`;

/* Who sold the old orders and has left; who collected their top-ups; who still sells. */
const LEFT = '00000000-0000-0000-0000-0000000000a1';
const COLLECTOR = '00000000-0000-0000-0000-0000000000a2';
const STAYS = '00000000-0000-0000-0000-0000000000a3';

const ALL_DOCS = [
  'HC-SO-010733', 'HC-SO-010734', 'HC-SO-OLD-UNPAID', 'HC-SO-OLD-ACTIVE',
  'HC-SO-OLD-NOBODY', 'HC-SO-NEW', 'HC2990-SO-OLD', 'HC-SO-GONE',
];

describePg('a departed salesperson’s old order reaches the portal once money does', () => {
  beforeAll(async () => {
    assertDisposableTestDatabase(url);
    sql = postgres(url, { max: 1, prepare: false, fetch_types: false, onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS scm; ${DROP_FIXTURE}`);
    await sql.unsafe(`
      CREATE TABLE public.project_event_types (id bigserial PRIMARY KEY, slug text NOT NULL, name text);
      CREATE TABLE public.projects (
        id bigint PRIMARY KEY, code text, name text, venue text, organizer text, brand text,
        start_date text, end_date text, status text, event_type_id bigint);

      /* The columns the three functions read, typed as production has them. */
      CREATE TABLE scm.staff (
        id uuid PRIMARY KEY, name text NOT NULL, staff_code text, user_id integer,
        active boolean NOT NULL DEFAULT true);
      CREATE TABLE scm.mfg_sales_orders (
        doc_no text PRIMARY KEY, salesperson_id uuid, company_id bigint NOT NULL DEFAULT 1,
        so_date date NOT NULL, local_total_sen integer, project_id integer, fair_match text,
        fair_date date, vp_brand text);
      CREATE VIEW scm.mfg_sales_orders_with_payment_totals AS
        SELECT doc_no, salesperson_id, company_id, so_date, local_total_sen FROM scm.mfg_sales_orders;
      CREATE TABLE scm.mfg_sales_order_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), doc_no text NOT NULL, line_no integer,
        created_at timestamptz DEFAULT now(), item_code text, variants jsonb);
      CREATE TABLE scm.mfg_sales_order_payments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), so_doc_no text NOT NULL, paid_at date NOT NULL,
        amount_sen integer, method text, collected_by uuid, created_at timestamptz NOT NULL DEFAULT now());

      /* The queue exactly as 20260912T1800 made it. */
      CREATE TABLE scm.venture_portal_outbox (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), doc_no text NOT NULL, op text NOT NULL,
        status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0, last_error text,
        portal_outcome text, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, revision integer NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX venture_portal_outbox_pending_doc_idx
        ON scm.venture_portal_outbox (doc_no) WHERE status = 'pending';

      INSERT INTO scm.staff (id, name, staff_code, user_id, active) VALUES
        ('${LEFT}', 'Ana Left', 'EMP-T01', 901, false),
        ('${COLLECTOR}', 'Ben Collects', 'EMP-T02', 902, true),
        ('${STAYS}', 'Cal Stays', 'EMP-T03', 903, true);

      INSERT INTO scm.mfg_sales_orders (doc_no, salesperson_id, company_id, so_date, local_total_sen) VALUES
        ('HC-SO-010733', '${LEFT}', 1, DATE '2026-03-10', 1400000),
        ('HC-SO-010734', '${LEFT}', 1, DATE '2026-03-10', 600000),
        ('HC-SO-OLD-UNPAID', '${LEFT}', 1, DATE '2026-04-01', 500000),
        ('HC-SO-OLD-ACTIVE', '${STAYS}', 1, DATE '2026-05-01', 500000),
        ('HC-SO-OLD-NOBODY', NULL, 1, DATE '2026-02-01', 500000),
        ('HC-SO-NEW', '${STAYS}', 1, DATE '2026-09-20', 500000),
        ('HC2990-SO-OLD', '${LEFT}', 2, DATE '2026-03-01', 500000);

      /* The AutoCount deposits come dated on the order date; the top-ups are real days. */
      INSERT INTO scm.mfg_sales_order_payments (so_doc_no, paid_at, amount_sen, method, collected_by, created_at) VALUES
        ('HC-SO-010733', DATE '2026-03-10', 420000, 'imported', NULL, TIMESTAMPTZ '2026-08-28 08:11:17+00'),
        ('HC-SO-010733', DATE '2026-11-02', 580000, 'transfer', '${COLLECTOR}', TIMESTAMPTZ '2026-11-02 11:56:07+00'),
        ('HC-SO-010734', DATE '2026-03-10', 80000, 'imported', NULL, TIMESTAMPTZ '2026-08-28 08:48:48+00'),
        ('HC-SO-010734', DATE '2026-11-02', 320000, 'transfer', '${COLLECTOR}', TIMESTAMPTZ '2026-11-02 12:03:14+00'),
        ('HC-SO-OLD-UNPAID', DATE '2026-04-01', 100000, 'imported', NULL, TIMESTAMPTZ '2026-08-28 09:00:00+00'),
        ('HC-SO-OLD-ACTIVE', DATE '2026-10-01', 200000, 'cash', '${STAYS}', TIMESTAMPTZ '2026-10-01 05:00:00+00'),
        ('HC-SO-OLD-NOBODY', DATE '2026-10-05', 200000, 'cash', NULL, TIMESTAMPTZ '2026-10-05 05:00:00+00'),
        ('HC2990-SO-OLD', DATE '2026-10-05', 200000, 'cash', NULL, TIMESTAMPTZ '2026-10-05 05:00:00+00');
    `);

    await applyMigration(sql, '_scm_vp_old_bills.sql');
  });

  afterAll(async () => {
    await sql.unsafe(DROP_FIXTURE);
    await sql.end({ timeout: 5 });
  });

  /* fetch_types is off (as in production), so postgres.js has no array type
     map: a list travels as one string and is split in SQL, and an answer
     comes back as one string too. Lists are compared sorted in JS: a doc_no
     ORDER BY follows the server's collation, which ranks `HC2990-` against
     `HC-SO-` differently under C and en_US. */
  const wanted = async (docNos: string[] | null, since: string | null): Promise<string[]> => {
    const list = docNos === null ? null : docNos.join(',');
    const [row] = await sql`
      SELECT array_to_string(scm.vp_old_orders_wanted(
               CASE WHEN ${list}::text IS NULL THEN NULL ELSE string_to_array(${list ?? ''}, ',') END,
               ${since}::date), ',') AS w`;
    const w = (row as { w: string | null }).w;
    return w ? w.split(',').sort() : [];
  };
  const payloads = async (docNos: string[]): Promise<Obj[]> =>
    (await sql`SELECT scm.vp_build_payloads(string_to_array(${docNos.join(',')}, ',')) AS p`)[0]!.p as Obj[];
  const requeue = async (companies: string | null, since: string | null, includeFailed: boolean): Promise<number> =>
    Number((await sql`
      SELECT scm.vp_requeue_undelivered(
               CASE WHEN ${companies}::text IS NULL THEN NULL ELSE string_to_array(${companies ?? ''}, ',')::bigint[] END,
               ${since}::date, ${includeFailed}) AS n`)[0]!.n);
  const pending = async (): Promise<string[]> =>
    ((await sql`SELECT doc_no FROM scm.venture_portal_outbox WHERE status = 'pending'`) as unknown as Array<{ doc_no: string }>)
      .map((r) => r.doc_no).sort();
  const resetOutbox = async () => {
    await sql`DELETE FROM scm.venture_portal_outbox`;
    /* What production holds for both departed-seller orders: delivered by the first
       backfill, every save since skipped as too old. */
    await sql`
      INSERT INTO scm.venture_portal_outbox (doc_no, op, status, portal_outcome, created_at, sent_at, last_error) VALUES
        ('HC-SO-010733', 'RECONCILE', 'sent', 'applied', TIMESTAMPTZ '2026-09-13 11:00:42+00', TIMESTAMPTZ '2026-09-13 11:15:45+00', NULL),
        ('HC-SO-010733', 'UPDATE', 'skipped', NULL, TIMESTAMPTZ '2026-11-02 11:56:06+00', NULL, 'dated before vp.since (2026-08-01)'),
        ('HC-SO-010734', 'RECONCILE', 'sent', 'applied', TIMESTAMPTZ '2026-09-13 11:00:42+00', TIMESTAMPTZ '2026-09-13 11:15:52+00', NULL),
        ('HC-SO-010734', 'INSERT:mfg_sales_order_payments', 'skipped', NULL, TIMESTAMPTZ '2026-11-02 12:03:14+00', NULL, 'dated before vp.since (2026-08-01)')`;
  };

  test('names only a departed salesperson’s old order that money reached since', async () => {
    expect(await wanted(ALL_DOCS, '2026-08-01')).toEqual(['HC-SO-010733', 'HC-SO-010734', 'HC2990-SO-OLD'].sort());
  });

  test('names nothing without a date floor or without documents', async () => {
    expect(await wanted(ALL_DOCS, null)).toEqual([]);
    expect(await wanted([], '2026-08-01')).toEqual([]);
    expect(await wanted(null, '2026-08-01')).toEqual([]);
  });

  test('a payment dated before the floor is not money since, whenever it was keyed', async () => {
    /* HC-SO-OLD-UNPAID's only payment is the AutoCount deposit, dated 2026-04-01. */
    expect(await wanted(['HC-SO-OLD-UNPAID'], '2026-08-01')).toEqual([]);
    expect(await wanted(['HC-SO-OLD-UNPAID'], '2026-04-01')).toEqual([]);
  });

  test('the salesperson says whether they still work here', async () => {
    const [old, current] = await payloads(['HC-SO-010734', 'HC-SO-NEW']);
    expect(old!.salesperson).toEqual({ id: LEFT, name: 'Ana Left', staff_code: 'EMP-T01', user_id: 901, active: false });
    expect(current!.salesperson).toMatchObject({ id: STAYS, active: true });
  });

  test('each payment names who collected it, and is otherwise its row', async () => {
    const [doc] = await payloads(['HC-SO-010734']);
    const payments = doc!.payments as Obj[];
    expect(payments.map((p) => [p.paid_at, p.amount_sen, p.collected_by, p.collected_by_name])).toEqual([
      ['2026-03-10', 80000, null, null],
      ['2026-11-02', 320000, COLLECTOR, 'Ben Collects'],
    ]);
    expect(Object.keys(payments[1]!).sort()).toEqual(
      ['amount_sen', 'collected_by', 'collected_by_name', 'created_at', 'id', 'method', 'paid_at', 'so_doc_no']);
  });

  test('the reconcile queues the wanted old orders whose newest change was never delivered', async () => {
    await resetOutbox();
    const n = await requeue('1', '2026-08-01', false);
    /* HC-SO-NEW has no sent row: queued by the old statement, as before. The
       two departed-seller orders by the new one. The 2990 order is another
       company's. */
    expect(await pending()).toEqual(['HC-SO-010733', 'HC-SO-010734', 'HC-SO-NEW']);
    expect(n).toBe(3);
    const ops = (await sql`SELECT DISTINCT op FROM scm.venture_portal_outbox WHERE status = 'pending'`) as unknown as Array<{ op: string }>;
    expect(ops.map((r) => r.op)).toEqual(['RECONCILE']);
  });

  test('once delivered as the newest change, nothing is queued again', async () => {
    await resetOutbox();
    await requeue('1', '2026-08-01', false);
    await sql`UPDATE scm.venture_portal_outbox SET status = 'sent', sent_at = now(), portal_outcome = 'applied'
               WHERE status = 'pending'`;
    expect(await requeue('1', '2026-08-01', false)).toBe(0);
    expect(await pending()).toEqual([]);
  });

  test('money recorded after the last delivery is queued even when no row says so', async () => {
    await resetOutbox();
    await sql`UPDATE scm.venture_portal_outbox SET status = 'sent', sent_at = TIMESTAMPTZ '2026-11-03 00:00:00+00'
               WHERE doc_no = 'HC-SO-010734' AND status = 'skipped'`;
    expect(await requeue('1', '2026-08-01', false)).toBeGreaterThanOrEqual(1);
    expect(await pending()).not.toContain('HC-SO-010734');
    await sql`DELETE FROM scm.venture_portal_outbox WHERE status = 'pending'`;
    /* A top-up keyed after that delivery, whose own row the capture trigger missed. */
    await sql`INSERT INTO scm.mfg_sales_order_payments (so_doc_no, paid_at, amount_sen, method, collected_by, created_at)
              VALUES ('HC-SO-010734', DATE '2026-11-05', 100000, 'transfer', ${COLLECTOR}, TIMESTAMPTZ '2026-11-05 03:00:00+00')`;
    await requeue('1', '2026-08-01', false);
    expect(await pending()).toContain('HC-SO-010734');
    await sql`DELETE FROM scm.mfg_sales_order_payments WHERE so_doc_no = 'HC-SO-010734' AND paid_at = DATE '2026-11-05'`;
  });

  test('a pending row is not doubled, a failed one waits to be released', async () => {
    await resetOutbox();
    await sql`INSERT INTO scm.venture_portal_outbox (doc_no, op, status) VALUES ('HC-SO-010733', 'UPDATE', 'pending')`;
    await sql`INSERT INTO scm.venture_portal_outbox (doc_no, op, status, attempts, last_error, created_at)
              VALUES ('HC-SO-010734', 'RECONCILE', 'failed', 6, 'http 500', TIMESTAMPTZ '2026-11-04 00:00:00+00')`;
    await requeue('1', '2026-08-01', false);
    const rows = (await sql`SELECT doc_no, op FROM scm.venture_portal_outbox WHERE status = 'pending'`) as unknown as Array<{ doc_no: string; op: string }>;
    expect(rows.map((r) => `${r.doc_no} ${r.op}`).sort()).toEqual(['HC-SO-010733 UPDATE', 'HC-SO-NEW RECONCILE']);
    await requeue('1', '2026-08-01', true);
    expect(await pending()).toContain('HC-SO-010734');
  });

  test('every company, and no floor, behave as before', async () => {
    await resetOutbox();
    await requeue(null, '2026-08-01', false);
    expect(await pending()).toEqual(['HC-SO-010733', 'HC-SO-010734', 'HC-SO-NEW', 'HC2990-SO-OLD'].sort());
    await sql`DELETE FROM scm.venture_portal_outbox`;
    /* No floor: every order with no sent row, old or new, as 20260912T1800 did. */
    await requeue(null, null, false);
    expect(await pending()).toEqual(ALL_DOCS.filter((d) => d !== 'HC-SO-GONE').sort());
  });

  test('only the service role may ask, and running the migration again changes nothing', async () => {
    const [acl] = await sql`SELECT coalesce(proacl::text, '') AS acl FROM pg_proc
                             WHERE oid = 'scm.vp_old_orders_wanted(text[],date)'::regprocedure`;
    expect((acl as { acl: string }).acl).not.toMatch(/(^|[{,])=X/);
    await applyMigration(sql, '_scm_vp_old_bills.sql');
    expect(await wanted(ALL_DOCS, '2026-08-01')).toEqual(['HC-SO-010733', 'HC-SO-010734', 'HC2990-SO-OLD'].sort());
  });
});
