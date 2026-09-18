import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

/*
 * A header Delivery Date change must not move a line already on a Delivery Order
 * or Sales Invoice (owner ruling 2026-09-15, shared/so-line-freeze.ts):
 * 「我更改任何东西（包括 delivery date ...），它就不会再影响到我们已经送货了的单，直接 freeze 起来」.
 *
 * The cascade runs INSIDE scm.apply_so_header_cas, so it is exercised here on a
 * real Postgres rather than through a fake builder. Fixture: exactly the columns
 * the function names, as in deliveryRebuildKeepsIdentity.pg.test.ts.
 */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

let admin: Sql;

const migration = (name: string) => readFile(
  fileURLToPath(new URL(`../src/db/migrations-pg/${name}`, import.meta.url)),
  'utf8',
);

const DOC = 'HC-SO-2609-001';
const WH_OLD = '00000000-0000-4000-8000-00000000000a';
const WH_NEW = '00000000-0000-4000-8000-00000000000b';

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
      version integer NOT NULL DEFAULT 1,
      edit_lease_token text,
      edit_lease_expires_at timestamptz,
      customer_id uuid,
      customer_delivery_date date,
      note text
    );
    CREATE TABLE scm.mfg_sales_order_items (
      id uuid PRIMARY KEY,
      doc_no text NOT NULL,
      line_delivery_date date,
      line_delivery_date_overridden boolean NOT NULL DEFAULT false,
      warehouse_id uuid,
      cancelled boolean NOT NULL DEFAULT false
    );
    CREATE TABLE scm.delivery_orders (id uuid PRIMARY KEY, so_doc_no text, status text NOT NULL);
    CREATE TABLE scm.delivery_order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), delivery_order_id uuid NOT NULL, so_item_id uuid);
    CREATE TABLE scm.sales_invoices (id uuid PRIMARY KEY, so_doc_no text, status text NOT NULL);
    CREATE TABLE scm.sales_invoice_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_invoice_id uuid NOT NULL, so_item_id uuid, do_item_id uuid);
    CREATE TABLE scm.pwp_codes (source_doc_no text, customer_id uuid, updated_at timestamptz);
    CREATE FUNCTION scm.upsert_customer_by_name_phone(text, text, text, bigint) RETURNS uuid
      LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
  `);
  await sql.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN BYPASSRLS;
      END IF;
    END $$;
  `);
  await sql.unsafe(await migration('20260915T1200_scm_so_header_cas_skip_frozen_lines.sql'));
}

const L_DELIVERED = '00000000-0000-4000-8000-000000000001';
const L_INVOICED = '00000000-0000-4000-8000-000000000002';
const L_OPEN = '00000000-0000-4000-8000-000000000003';
const DO_1 = '00000000-0000-4000-8000-0000000000d1';
const SI_1 = '00000000-0000-4000-8000-0000000000e1';

const cas = (sql: Sql, opts: { deliveryDate?: string; warehouse?: string }) => sql.unsafe(
  `SELECT * FROM scm.apply_so_header_cas(
     p_doc_no => $1, p_expected_version => 1, p_required_lease => NULL, p_patch => $2::jsonb,
     p_apply_warehouse => $3, p_warehouse_id => $4::uuid,
     p_apply_delivery_date => $5, p_delivery_date => $6::date)`,
  [
    DOC,
    admin.json(opts.deliveryDate ? { customer_delivery_date: opts.deliveryDate, version: 2 } : { version: 2 }),
    Boolean(opts.warehouse), opts.warehouse ?? null,
    Boolean(opts.deliveryDate), opts.deliveryDate ?? null,
  ],
);

const lines = async (sql: Sql) => Object.fromEntries(
  (await sql.unsafe(`SELECT id, to_char(line_delivery_date, 'YYYY-MM-DD') d, warehouse_id FROM scm.mfg_sales_order_items`))
    .map((r) => [r.id, { d: r.d as string | null, wh: r.warehouse_id as string | null }]),
);

describePg('apply_so_header_cas leaves frozen lines alone (20260915T1200)', () => {
  beforeAll(async () => { admin = postgres(url, { max: 2, onnotice: () => {} }); });
  afterAll(async () => { await admin?.end({ timeout: 5 }); });

  beforeEach(async () => {
    await resetFixture(admin);
    await admin.unsafe(`
      INSERT INTO scm.mfg_sales_orders (doc_no, version, customer_delivery_date) VALUES ('${DOC}', 1, '2026-09-20');
      INSERT INTO scm.mfg_sales_order_items (id, doc_no, line_delivery_date, warehouse_id) VALUES
        ('${L_DELIVERED}', '${DOC}', '2026-09-20', NULL),
        ('${L_INVOICED}',  '${DOC}', '2026-09-20', NULL),
        ('${L_OPEN}',      '${DOC}', '2026-09-20', NULL);
      INSERT INTO scm.delivery_orders (id, so_doc_no, status) VALUES ('${DO_1}', '${DOC}', 'DRAFT');
      INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id) VALUES ('${DO_1}', '${L_DELIVERED}');
      INSERT INTO scm.sales_invoices (id, so_doc_no, status) VALUES ('${SI_1}', '${DOC}', 'SENT');
      INSERT INTO scm.sales_invoice_items (sales_invoice_id, so_item_id) VALUES ('${SI_1}', '${L_INVOICED}');
    `);
  });

  test('the header date moves, the open line follows, the delivered and invoiced lines keep theirs', async () => {
    const [res] = await cas(admin, { deliveryDate: '2026-10-01' });
    expect(res.applied).toBe(true);
    const after = await lines(admin);
    expect(after[L_OPEN].d).toBe('2026-10-01');
    expect(after[L_DELIVERED].d).toBe('2026-09-20');
    expect(after[L_INVOICED].d).toBe('2026-09-20');
    const [hdr] = await admin.unsafe(`SELECT to_char(customer_delivery_date, 'YYYY-MM-DD') d FROM scm.mfg_sales_orders`);
    expect(hdr.d).toBe('2026-10-01');
  });

  test('a CANCELLED delivery order releases its line to the cascade', async () => {
    await admin.unsafe(`UPDATE scm.delivery_orders SET status = 'CANCELLED'`);
    await cas(admin, { deliveryDate: '2026-10-01' });
    expect((await lines(admin))[L_DELIVERED].d).toBe('2026-10-01');
  });

  test('the State warehouse rebind skips a frozen NULL-warehouse line', async () => {
    await cas(admin, { warehouse: WH_NEW });
    const after = await lines(admin);
    expect(after[L_OPEN].wh).toBe(WH_NEW);
    expect(after[L_DELIVERED].wh).toBeNull();
    expect(after[L_INVOICED].wh).toBeNull();
    expect(WH_OLD).not.toBe(WH_NEW);
  });

  test('a live downstream line naming no SO line freezes every line', async () => {
    await admin.unsafe(`INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id) VALUES ('${DO_1}', NULL)`);
    await cas(admin, { deliveryDate: '2026-10-01' });
    const after = await lines(admin);
    expect(after[L_OPEN].d).toBe('2026-09-20');
  });
});
