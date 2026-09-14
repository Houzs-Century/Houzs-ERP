import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

/*
 * *_scm_so_list_line_filter_fields.sql — the three computed fields the Sales
 * Order list filters on (owner 2026-09-14: Warehouse, Item category, Has pending
 * amendment). Each answers a question about an order's LINES or AMENDMENTS while
 * the list reads the header VIEW, so the answer has to be computed per row in
 * the database; PostgREST exposes a function that takes the view's row type as
 * a filterable field of that view.
 *
 * The fixture is the view's real shape where it matters (the function argument
 * is the view's composite type) and the child tables' real columns. The
 * migration is read by SUFFIX and replayed whole, twice.
 *
 * Asserted: which orders each field selects, that a cancelled line and another
 * company's row never count, that "open" means exactly what the SO detail's
 * has_open_amendment means (lane row REQUESTED, legacy row not SENT/REJECTED),
 * and that service_role may execute the functions.
 */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

async function migrationSql(suffix: string): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(suffix));
  if (files.length !== 1) {
    throw new Error(`expected exactly one *${suffix} migration, found ${files.length}: ${files.join(', ')}`);
  }
  return readFile(join(migrationsDir, files[0]!), 'utf8');
}

let admin: Sql;

const WH_A = '11111111-1111-4111-8111-111111111111';
const WH_B = '22222222-2222-4222-8222-222222222222';

async function resetFixture(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') {
    throw new Error('PG integration tests require the disposable houzs_test database');
  }
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS scm;
    DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DROP VIEW IF EXISTS scm.mfg_sales_orders_with_payment_totals CASCADE;
    DROP TABLE IF EXISTS scm.so_amendments CASCADE;
    DROP TABLE IF EXISTS scm.mfg_sales_order_items CASCADE;
    DROP TABLE IF EXISTS scm.mfg_sales_order_payments CASCADE;
    DROP TABLE IF EXISTS scm.mfg_sales_orders CASCADE;
    DO $$ BEGIN CREATE TYPE scm.so_amendment_status AS ENUM ('REQUESTED','SUPPLIER_PENDING','SO_APPROVED','PO_APPROVED','SENT','REJECTED');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    CREATE TABLE scm.mfg_sales_orders (
      doc_no text PRIMARY KEY, company_id bigint NOT NULL, status text, local_total_sen bigint DEFAULT 0
    );
    CREATE TABLE scm.mfg_sales_order_payments (so_doc_no text, amount_sen bigint);
    CREATE TABLE scm.mfg_sales_order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), doc_no text NOT NULL, company_id bigint NOT NULL,
      item_group text, warehouse_id uuid, cancelled boolean NOT NULL DEFAULT false
    );
    CREATE TABLE scm.so_amendments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), so_doc_no text NOT NULL, company_id bigint NOT NULL,
      status scm.so_amendment_status NOT NULL DEFAULT 'REQUESTED', lane text
    );
    CREATE VIEW scm.mfg_sales_orders_with_payment_totals AS
      SELECT so.doc_no, so.status, so.local_total_sen, so.company_id,
             COALESCE(p.paid_total, 0::bigint) AS paid_total_sen,
             so.local_total_sen - COALESCE(p.paid_total, 0::bigint) AS balance_sen_live
        FROM scm.mfg_sales_orders so
        LEFT JOIN (SELECT so_doc_no, sum(amount_sen) AS paid_total FROM scm.mfg_sales_order_payments GROUP BY so_doc_no) p
          ON p.so_doc_no = so.doc_no;

    INSERT INTO scm.mfg_sales_orders (doc_no, company_id, status) VALUES
      ('SO-1', 1, 'CONFIRMED'), ('SO-2', 1, 'CONFIRMED'), ('SO-3', 1, 'CONFIRMED'),
      ('SO-4', 1, 'CONFIRMED'), ('SO-5', 1, 'CONFIRMED'), ('SO-X', 2, 'CONFIRMED');
    INSERT INTO scm.mfg_sales_order_items (doc_no, company_id, item_group, warehouse_id, cancelled) VALUES
      ('SO-1', 1, 'SOFA', '${WH_A}', false),
      ('SO-1', 1, 'ACCESSORY', '${WH_B}', false),
      ('SO-2', 1, 'Mattress ', '${WH_B}', false),
      ('SO-2', 1, 'BEDFRAME', NULL, false),
      ('SO-3', 1, 'SOFA', '${WH_A}', true),
      ('SO-3', 1, 'SERVICE', NULL, false),
      ('SO-X', 2, 'SOFA', '${WH_A}', false),
      ('SO-4', 2, 'SOFA', '${WH_A}', false);
    INSERT INTO scm.so_amendments (so_doc_no, company_id, status, lane) VALUES
      ('SO-1', 1, 'REQUESTED', 'header'),
      ('SO-2', 1, 'SO_APPROVED', 'lines'),
      ('SO-3', 1, 'PO_APPROVED', NULL),
      ('SO-4', 1, 'SENT', NULL),
      ('SO-5', 1, 'REJECTED', 'header'),
      ('SO-X', 2, 'REQUESTED', 'header');
  `);
}

async function docsWhere(sql: Sql, predicate: string): Promise<string[]> {
  const rows = await sql.unsafe<Array<{ doc_no: string }>>(
    `SELECT doc_no FROM scm.mfg_sales_orders_with_payment_totals v WHERE ${predicate} ORDER BY doc_no`,
  );
  return rows.map((r) => r.doc_no);
}

describePg('SO list line filter fields (migrations-pg *_scm_so_list_line_filter_fields.sql)', () => {
  beforeAll(async () => {
    admin = postgres(url, { max: 2, onnotice: () => {} });
    await resetFixture(admin);
    const sqlText = await migrationSql('_scm_so_list_line_filter_fields.sql');
    await admin.unsafe(sqlText);
    await admin.unsafe(sqlText); // a second replay is a clean no-op
  });

  afterAll(async () => {
    if (admin) await admin.end();
  });

  test('warehouse: orders with a LIVE line in the warehouse, never a cancelled line', async () => {
    expect(await docsWhere(admin, `scm.so_line_warehouse_ids(v) && ARRAY['${WH_A}'::uuid]`)).toEqual(['SO-1', 'SO-X']);
    expect(await docsWhere(admin, `v.company_id = 1 AND scm.so_line_warehouse_ids(v) && ARRAY['${WH_A}'::uuid]`)).toEqual(['SO-1']);
    expect(await docsWhere(admin, `v.company_id = 1 AND scm.so_line_warehouse_ids(v) && ARRAY['${WH_B}'::uuid]`)).toEqual(['SO-1', 'SO-2']);
  });

  test('a line stamped with another company is not read as this order\'s', async () => {
    const [row] = await admin<Array<{ ids: string[]; cats: string[] }>>`
      SELECT scm.so_line_warehouse_ids(v) AS ids, scm.so_line_categories(v) AS cats
        FROM scm.mfg_sales_orders_with_payment_totals v WHERE v.doc_no = 'SO-4'`;
    expect(row.ids).toEqual([]);
    expect(row.cats).toEqual([]);
  });

  test('item category: the list\'s own buckets, case and spacing folded, cancelled lines ignored', async () => {
    const q = (cat: string) => docsWhere(admin, `v.company_id = 1 AND scm.so_line_categories(v) && ARRAY['${cat}']`);
    expect(await q('SOFA')).toEqual(['SO-1']);
    expect(await q('MATTRESS')).toEqual(['SO-2']);
    expect(await q('BEDFRAME')).toEqual(['SO-2']);
    expect(await q('ACCESSORY')).toEqual(['SO-1']);
    expect(await q('SERVICE')).toEqual(['SO-3']);
  });

  test('pending amendment: a lane row that is REQUESTED, or a legacy row not yet SENT or REJECTED', async () => {
    expect(await docsWhere(admin, `v.company_id = 1 AND scm.so_has_open_amendment(v)`)).toEqual(['SO-1', 'SO-3']);
    expect(await docsWhere(admin, `v.company_id = 1 AND NOT scm.so_has_open_amendment(v)`)).toEqual(['SO-2', 'SO-4', 'SO-5']);
  });

  test('service_role may execute the three functions', async () => {
    const rows = await admin<Array<{ fn: string; ok: boolean }>>`
      SELECT p.proname AS fn, has_function_privilege('service_role', p.oid, 'EXECUTE') AS ok
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'scm' AND p.proname IN ('so_line_warehouse_ids', 'so_line_categories', 'so_has_open_amendment')`;
    expect(rows.map((r) => `${r.fn}:${r.ok}`).sort()).toEqual([
      'so_has_open_amendment:true', 'so_line_categories:true', 'so_line_warehouse_ids:true',
    ]);
  });
});
