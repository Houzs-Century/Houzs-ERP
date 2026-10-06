import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

/*
 * Owner 2026-10-06: a line delivery date a user set by hand survives a later
 * header Delivery Date change (migration 20261006T0402). Lines still following
 * the header move; frozen lines (on a live DO) never move.
 */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

let admin: Sql;

const migration = (name: string) => readFile(
  fileURLToPath(new URL(`../src/db/migrations-pg/${name}`, import.meta.url)),
  'utf8',
);

const DOC = 'HC-SO-HANDSET-1';
const OLD = '2026-10-10';
const NEW = '2026-10-20';
const HAND = '2026-10-15';

async function resetFixture(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') {
    throw new Error('PG integration tests require the disposable houzs_test database');
  }
  await sql.unsafe(`
    DROP SCHEMA IF EXISTS scm CASCADE;
    CREATE SCHEMA scm;
    CREATE TABLE scm.mfg_sales_orders (
      doc_no text PRIMARY KEY,
      company_id bigint,
      version integer NOT NULL DEFAULT 1,
      edit_lease_token text,
      edit_lease_expires_at timestamptz,
      customer_id uuid,
      customer_delivery_date date
    );
    CREATE TABLE scm.mfg_sales_order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      doc_no text NOT NULL,
      item_code text,
      cancelled boolean NOT NULL DEFAULT false,
      warehouse_id uuid,
      line_delivery_date date,
      line_delivery_date_overridden boolean NOT NULL DEFAULT false
    );
    CREATE TABLE scm.delivery_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), so_doc_no text, status text);
    CREATE TABLE scm.delivery_order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), delivery_order_id uuid, so_item_id uuid);
    CREATE TABLE scm.sales_invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), so_doc_no text, status text);
    CREATE TABLE scm.sales_invoice_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_invoice_id uuid, so_item_id uuid, do_item_id uuid);
    CREATE TABLE scm.pwp_codes (source_doc_no text, customer_id uuid, updated_at timestamptz);
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN BYPASSRLS;
      END IF;
    END $$;
  `);
  await sql.unsafe(await migration('20261006T0402_scm_so_header_cas_keeps_handset_lines.sql'));
}

async function line(code: string): Promise<{ d: string | null; o: boolean }> {
  const [r] = await admin<{ d: string | null; o: boolean }[]>`
    SELECT line_delivery_date::text AS d, line_delivery_date_overridden AS o
    FROM scm.mfg_sales_order_items WHERE doc_no = ${DOC} AND item_code = ${code}`;
  return r;
}

async function changeHeaderDate(to: string | null): Promise<void> {
  const [r] = await admin<{ applied: boolean }[]>`
    SELECT applied FROM scm.apply_so_header_cas(
      p_doc_no => ${DOC}, p_expected_version => 1, p_required_lease => NULL,
      p_patch => ${admin.json({ customer_delivery_date: to })},
      p_apply_delivery_date => true, p_delivery_date => ${to}::date)`;
  expect(r.applied).toBe(true);
}

describePg('SO header Delivery Date change keeps hand-set line dates', () => {
  beforeAll(async () => {
    admin = postgres(url, { max: 1, onnotice: () => undefined });
    await resetFixture(admin);
  });
  afterAll(async () => { await admin?.end(); });

  beforeEach(async () => {
    await admin.unsafe(`TRUNCATE scm.mfg_sales_orders, scm.mfg_sales_order_items,
      scm.delivery_orders, scm.delivery_order_items, scm.sales_invoices, scm.sales_invoice_items`);
    await admin`INSERT INTO scm.mfg_sales_orders (doc_no, customer_delivery_date) VALUES (${DOC}, ${OLD})`;
    await admin`INSERT INTO scm.mfg_sales_order_items (doc_no, item_code, line_delivery_date, line_delivery_date_overridden) VALUES
      (${DOC}, 'HAND', ${HAND}, true),
      (${DOC}, 'FOLLOW', ${OLD}, false),
      (${DOC}, 'FLAGGED-ON-HEADER', ${OLD}, true),
      (${DOC}, 'FROZEN', ${OLD}, false)`;
    const [d] = await admin<{ id: string }[]>`INSERT INTO scm.delivery_orders (so_doc_no, status) VALUES (${DOC}, 'DRAFT') RETURNING id`;
    await admin`INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id)
      SELECT ${d.id}, id FROM scm.mfg_sales_order_items WHERE item_code = 'FROZEN'`;
  });

  test('hand-set line keeps date and flag; following line moves; frozen line stays', async () => {
    await changeHeaderDate(NEW);
    expect(await line('HAND')).toEqual({ d: HAND, o: true });
    expect(await line('FOLLOW')).toEqual({ d: NEW, o: false });
    expect(await line('FROZEN')).toEqual({ d: OLD, o: false });
  });

  test('the flag alone decides: a flagged line on the old header date keeps its date and flag', async () => {
    await changeHeaderDate(NEW);
    expect(await line('FLAGGED-ON-HEADER')).toEqual({ d: OLD, o: true });
  });

  test('clearing the header date (Remove Processing Date) still clears every non-frozen line', async () => {
    await changeHeaderDate(null);
    expect(await line('HAND')).toEqual({ d: null, o: false });
    expect(await line('FOLLOW')).toEqual({ d: null, o: false });
    expect(await line('FROZEN')).toEqual({ d: OLD, o: false });
  });
});
