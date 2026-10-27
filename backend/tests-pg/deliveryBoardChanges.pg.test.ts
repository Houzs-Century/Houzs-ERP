/* EXECUTES migration 20261027T1000 (Delivery Planning change log) on real
   Postgres. Owner 2026-10-27, option B: the board re-reads only the orders that
   changed, so every write the board can see must land in the log - including
   the ones that never touch the order header (a line's stock flip, a DO line,
   crew, a trip) - and a failure to log must never fail the write itself. */
import { readFileSync } from 'node:fs';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
let sql: Sql;

const DO1 = '11111111-1111-4111-8111-111111111111';
const TRIP1 = '22222222-2222-4222-8222-222222222222';
const ITEM1 = '33333333-3333-4333-8333-333333333333';

async function reset(s: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  if (parsed.pathname !== '/houzs_test') throw new Error('PG integration tests require the disposable houzs_test database');
  await s.unsafe(`
    DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF; END $$;
    CREATE SCHEMA IF NOT EXISTS scm;
    DROP TABLE IF EXISTS scm.delivery_board_changes CASCADE;
    DROP TABLE IF EXISTS scm.mfg_sales_orders, scm.mfg_sales_order_items, scm.mfg_sales_order_payments, scm.delivery_orders,
      scm.delivery_order_items, scm.delivery_order_crew, scm.trip_stops, scm.trips, scm.dp_orders, public.assr_cases, public.projects CASCADE;
    CREATE TABLE scm.mfg_sales_orders (doc_no text PRIMARY KEY, company_id bigint, status text);
    CREATE TABLE scm.mfg_sales_order_items (id uuid PRIMARY KEY, doc_no text, company_id bigint, stock_status text);
    CREATE TABLE scm.mfg_sales_order_payments (id serial PRIMARY KEY, so_doc_no text, company_id bigint, amount_sen int);
    CREATE TABLE scm.delivery_orders (id uuid PRIMARY KEY, so_doc_no text, company_id bigint, status text);
    CREATE TABLE scm.delivery_order_items (id serial PRIMARY KEY, delivery_order_id uuid, qty int);
    CREATE TABLE scm.delivery_order_crew (do_id uuid PRIMARY KEY, driver text);
    CREATE TABLE scm.trips (id uuid PRIMARY KEY, status text);
    CREATE TABLE scm.trip_stops (id serial PRIMARY KEY, trip_id uuid, do_id uuid, assr_case_id int);
    CREATE TABLE scm.dp_orders (id serial PRIMARY KEY, company_id bigint, status text);
    CREATE TABLE public.assr_cases (id serial PRIMARY KEY, company_id bigint, stage text);
    CREATE TABLE public.projects (id serial PRIMARY KEY, company_id bigint, name text);
  `);
  await s.unsafe(readFileSync(new URL('../src/db/migrations-pg/20261027T1000_scm_delivery_board_changes.sql', import.meta.url), 'utf8'));
}

const logged = async (): Promise<string[]> =>
  (await sql<Array<{ doc_no: string }>>`SELECT doc_no FROM scm.delivery_board_changes ORDER BY id`).map((r) => r.doc_no);
const clear = () => sql`DELETE FROM scm.delivery_board_changes`;

describePg('delivery board change log (migration 20261027T1000)', () => {
  beforeAll(async () => { sql = postgres(url, { max: 1, onnotice: () => undefined }); await reset(sql); });
  afterAll(async () => { await sql?.end(); });

  test('order header, line, payment and DO writes log the order', async () => {
    await clear();
    await sql`INSERT INTO scm.mfg_sales_orders VALUES ('SO-1', 1, 'CONFIRMED')`;
    await sql`INSERT INTO scm.mfg_sales_order_items VALUES (${ITEM1}, 'SO-1', 1, 'PENDING')`;
    await sql`UPDATE scm.mfg_sales_order_items SET stock_status = 'READY' WHERE id = ${ITEM1}`;
    await sql`INSERT INTO scm.mfg_sales_order_payments (so_doc_no, company_id, amount_sen) VALUES ('SO-1', 1, 100)`;
    await sql`INSERT INTO scm.delivery_orders VALUES (${DO1}, 'SO-1', 1, 'DRAFT')`;
    expect(await logged()).toEqual(['SO-1', 'SO-1', 'SO-1', 'SO-1', 'SO-1']);
    const [row] = await sql<Array<{ company_id: string }>>`SELECT company_id FROM scm.delivery_board_changes LIMIT 1`;
    expect(Number(row!.company_id)).toBe(1);
  });

  test('DO lines, crew and trip stops resolve to the order through the DO', async () => {
    await clear();
    await sql`INSERT INTO scm.delivery_order_items (delivery_order_id, qty) VALUES (${DO1}, 1)`;
    await sql`INSERT INTO scm.delivery_order_crew VALUES (${DO1}, 'Ali')`;
    await sql`INSERT INTO scm.trips VALUES (${TRIP1}, 'PLANNED')`;
    await sql`INSERT INTO scm.trip_stops (trip_id, do_id) VALUES (${TRIP1}, ${DO1})`;
    expect(await logged()).toEqual(['SO-1', 'SO-1', 'SO-1']);
  });

  test('a trip change logs every order on it; service / DP / project legs log *OTHER*', async () => {
    await clear();
    await sql`UPDATE scm.trips SET status = 'IN_PROGRESS' WHERE id = ${TRIP1}`;
    await sql`INSERT INTO public.assr_cases (company_id, stage) VALUES (1, 'pending_delivery_service')`;
    await sql`INSERT INTO scm.dp_orders (company_id, status) VALUES (1, 'NEW')`;
    await sql`INSERT INTO public.projects (company_id, name) VALUES (1, 'Fair')`;
    expect(await logged()).toEqual(['SO-1', '*OTHER*', '*OTHER*', '*OTHER*', '*OTHER*']);
  });

  test('a delete logs the order it removed', async () => {
    await clear();
    await sql`DELETE FROM scm.mfg_sales_order_items WHERE id = ${ITEM1}`;
    expect(await logged()).toEqual(['SO-1']);
  });

  test('a broken log never fails the business write', async () => {
    await sql`ALTER TABLE scm.delivery_board_changes RENAME TO delivery_board_changes_away`;
    try {
      await sql`UPDATE scm.mfg_sales_orders SET status = 'DELIVERED' WHERE doc_no = 'SO-1'`;
      const [so] = await sql<Array<{ status: string }>>`SELECT status FROM scm.mfg_sales_orders WHERE doc_no = 'SO-1'`;
      expect(so!.status).toBe('DELIVERED');
    } finally {
      await sql`ALTER TABLE scm.delivery_board_changes_away RENAME TO delivery_board_changes`;
    }
  });
});
