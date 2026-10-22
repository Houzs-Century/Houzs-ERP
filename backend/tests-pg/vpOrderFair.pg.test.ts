import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';
import { assertDisposableTestDatabase } from './lib/doc-no-fixture';

/* EXECUTES the order feed's fair SQL (migration *_scm_vp_order_fair.sql)
 * against real Postgres: the `fair` key every delivery carries, the capture
 * trigger's event columns, the project trigger, and the one-time requeue.
 *
 * The portal takes the fair's venue, organizer and days as the bill's fair,
 * over anything typed on its side, so what matters is that the right project
 * travels with the right order, in named keys, and that re-picking the event
 * or editing the project reaches the portal at all.
 *
 * The migration file is located by SUFFIX, never by number: parallel PRs
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
  DROP FUNCTION IF EXISTS scm.enqueue_vp_outbox() CASCADE;
  DROP FUNCTION IF EXISTS scm.enqueue_vp_outbox_project() CASCADE;
  DROP FUNCTION IF EXISTS scm.vp_build_payloads(text[]) CASCADE;
`;

const pending = async (): Promise<Array<{ doc_no: string; op: string }>> =>
  (await sql`SELECT doc_no, op FROM scm.venture_portal_outbox WHERE status = 'pending' ORDER BY doc_no`) as unknown as Array<{ doc_no: string; op: string }>;

describePg('the order feed names the fair an order was written at', () => {
  beforeAll(async () => {
    assertDisposableTestDatabase(url);
    sql = postgres(url, { max: 1, prepare: false, fetch_types: false, onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS scm; ${DROP_FIXTURE}`);
    await sql.unsafe(`
      CREATE TABLE public.project_event_types (id bigserial PRIMARY KEY, slug text NOT NULL, name text);
      CREATE TABLE public.projects (
        id bigint PRIMARY KEY, code text, name text, venue text, organizer text, brand text,
        start_date text, end_date text, status text, event_type_id bigint, notes text, company_id bigint);

      /* The sources vp_build_payloads reads, with every column the capture
         trigger names. The payment-totals relation is a VIEW, as in production. */
      CREATE TABLE scm.mfg_sales_orders (
        doc_no text PRIMARY KEY, salesperson_id uuid, company_id bigint, so_date date,
        status text, on_hold boolean, branding text, agent text, debtor_name text, debtor_code text,
        sales_location text, local_total_sen integer, subtotal_sen integer, balance_sen integer,
        deposit_sen integer, paid_sen integer, delivery_fee_sen integer, total_cost_sen integer,
        total_margin_sen integer, venue text, venue_id uuid, project_id integer, fair_match text,
        fair_date date, remark text);
      CREATE VIEW scm.mfg_sales_orders_with_payment_totals AS
        SELECT doc_no, salesperson_id, local_total_sen, company_id FROM scm.mfg_sales_orders;
      CREATE TABLE scm.staff (id uuid PRIMARY KEY, name text, staff_code text, user_id integer);
      CREATE TABLE scm.mfg_sales_order_items (
        id uuid PRIMARY KEY, doc_no text NOT NULL, line_no integer, created_at timestamptz DEFAULT now(),
        item_code text, variants jsonb);
      CREATE TABLE scm.mfg_sales_order_payments (
        id uuid PRIMARY KEY, so_doc_no text NOT NULL, paid_at date, amount_sen integer,
        created_at timestamptz DEFAULT now());

      /* The queue and its enqueue function exactly as 20260912T1800 made them. */
      CREATE TABLE scm.venture_portal_outbox (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), doc_no text NOT NULL, op text NOT NULL,
        status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX venture_portal_outbox_pending_doc_idx
        ON scm.venture_portal_outbox (doc_no) WHERE status = 'pending';
      CREATE FUNCTION scm.enqueue_vp_outbox() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        BEGIN
          INSERT INTO scm.venture_portal_outbox (doc_no, op)
          VALUES (COALESCE(NEW.doc_no, OLD.doc_no), TG_OP)
          ON CONFLICT (doc_no) WHERE status = 'pending' DO NOTHING;
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        RETURN NULL;
      END $fn$;

      INSERT INTO public.project_event_types (id, slug, name) VALUES (1, 'exhibition', 'Exhibition'), (2, 'solo', 'Solo');
      INSERT INTO public.projects (id, code, name, venue, organizer, brand, start_date, end_date, status, event_type_id, company_id) VALUES
        (2212, '2026-09-MLE-PWCC-ZANOTTI', 'PULAU PINANG [ZANOTTI] MLE @ PENANG WATERFRONT CONVENTION CENTRE',
         'PENANG WATERFRONT CONVENTION CENTRE', 'MLE', 'ZANOTTI', '2026-09-25', '2026-09-27', 'confirmed', 1, 1),
        (348, '2026-09-MLE-PWCC-AKEMI', 'Pulau Pinang [AKEMI] MLE @ PENANG WATERFRONT CONVENTION CENTRE',
         'PENANG WATERFRONT CONVENTION CENTRE', 'MLE', 'AKEMI', '2026-09-25', '2026-09-27', 'confirmed', 1, 1),
        (340, '2026-08-REX-MID-VALLEY-AKEMI', 'Kuala Lumpur [AKEMI] REX @ MID VALLEY',
         'MID VALLEY', 'REX', 'AKEMI', '2026-08-11', '2026-08-13', 'confirmed', NULL, 1);

      INSERT INTO scm.staff (id, name, staff_code, user_id)
        VALUES ('00000000-0000-0000-0000-0000000000f1', 'Lucas Tan', 'EMP-1', 90);
      /* Written BEFORE the migration, so its one-time requeue has something to find. */
      INSERT INTO scm.mfg_sales_orders (doc_no, salesperson_id, company_id, so_date, local_total_sen, venue, project_id, fair_match, fair_date) VALUES
        ('HC-SO-FAIR', '00000000-0000-0000-0000-0000000000f1', 1, DATE '2026-09-26', 500000,
         'PENANG WATERFRONT CONVENTION CENTRE', 2212, 'PICKED', DATE '2026-09-25'),
        ('HC-SO-NOFAIR', '00000000-0000-0000-0000-0000000000f1', 1, DATE '2026-09-25', 100000, '2990s PJ', NULL, 'PENDING', NULL),
        ('HC-SO-AUGUST', '00000000-0000-0000-0000-0000000000f1', 1, DATE '2026-08-14', 300000, 'MID VALLEY', 340, 'PICKED', NULL);
    `);

    await applyMigration(sql, '_scm_vp_order_fair.sql');
  });

  afterAll(async () => {
    await sql.unsafe(DROP_FIXTURE);
    await sql.end({ timeout: 5 });
  });

  /* fetch_types is off (as in production), so postgres.js has no array type
     map: the list travels as one string and is split in SQL. */
  const payloads = async (docNos: string[]): Promise<Obj[]> =>
    (await sql`SELECT scm.vp_build_payloads(string_to_array(${docNos.join(',')}, ',')) AS p`)[0]!.p as Obj[];

  test('the one-time requeue queued every order with a project from September, and only those', async () => {
    expect(await pending()).toEqual([{ doc_no: 'HC-SO-FAIR', op: 'BACKFILL:fair' }]);
  });

  test('a delivery names the picked project in named keys, with the order`s own verdict and day', async () => {
    const [doc] = await payloads(['HC-SO-FAIR']);
    expect(doc!.fair).toEqual({
      projectId: 2212,
      code: '2026-09-MLE-PWCC-ZANOTTI',
      name: 'PULAU PINANG [ZANOTTI] MLE @ PENANG WATERFRONT CONVENTION CENTRE',
      venue: 'PENANG WATERFRONT CONVENTION CENTRE',
      organizer: 'MLE',
      brand: 'ZANOTTI',
      startDate: '2026-09-25',
      endDate: '2026-09-27',
      status: 'confirmed',
      eventType: 'exhibition',
      match: 'PICKED',
      fairDate: '2026-09-25',
    });
  });

  test('an order with no project carries fair: null, and the rest of the delivery is as before', async () => {
    const [none, gone] = await payloads(['HC-SO-NOFAIR', 'HC-SO-GONE']);
    expect(none).toHaveProperty('fair', null);
    expect(none!.header).toEqual({
      doc_no: 'HC-SO-NOFAIR', salesperson_id: '00000000-0000-0000-0000-0000000000f1', local_total_sen: 100000, company_id: 1,
    });
    expect(none!.salesperson).toEqual({ id: '00000000-0000-0000-0000-0000000000f1', name: 'Lucas Tan', staff_code: 'EMP-1', user_id: 90 });
    expect(gone).toMatchObject({ docNo: 'HC-SO-GONE', deleted: true });
    expect(gone).not.toHaveProperty('fair');
  });

  test('re-picking the event on a saved order queues it; an unrelated column does not', async () => {
    await sql`DELETE FROM scm.venture_portal_outbox`;
    await sql`UPDATE scm.mfg_sales_orders SET remark = 'note only' WHERE doc_no = 'HC-SO-NOFAIR'`;
    expect(await pending()).toEqual([]);
    await sql`UPDATE scm.mfg_sales_orders SET project_id = 348, fair_match = 'PICKED' WHERE doc_no = 'HC-SO-NOFAIR'`;
    expect(await pending()).toEqual([{ doc_no: 'HC-SO-NOFAIR', op: 'UPDATE' }]);
    await sql`DELETE FROM scm.venture_portal_outbox`;
    await sql`UPDATE scm.mfg_sales_orders SET fair_date = DATE '2026-09-26' WHERE doc_no = 'HC-SO-NOFAIR'`;
    await sql`UPDATE scm.mfg_sales_orders SET venue = 'PWCC' WHERE doc_no = 'HC-SO-AUGUST'`;
    expect((await pending()).map((r) => r.doc_no)).toEqual(['HC-SO-AUGUST', 'HC-SO-NOFAIR']);
  });

  test('a project whose organizer, days or status change queues every order pointing at it', async () => {
    await sql`DELETE FROM scm.venture_portal_outbox`;
    await sql`UPDATE public.projects SET notes = 'booth 12' WHERE id = 2212`;
    expect(await pending()).toEqual([]);
    await sql`UPDATE public.projects SET organizer = 'MLE EVENTS' WHERE id = 2212`;
    expect(await pending()).toEqual([{ doc_no: 'HC-SO-FAIR', op: 'UPDATE:projects' }]);
    await sql`DELETE FROM scm.venture_portal_outbox`;
    await sql`UPDATE public.projects SET status = 'cancelled' WHERE id = 348`;
    expect(await pending()).toEqual([{ doc_no: 'HC-SO-NOFAIR', op: 'UPDATE:projects' }]);
    const [doc] = await payloads(['HC-SO-NOFAIR']);
    expect(doc!.fair).toMatchObject({ projectId: 348, status: 'cancelled', fairDate: '2026-09-26' });
  });
});
