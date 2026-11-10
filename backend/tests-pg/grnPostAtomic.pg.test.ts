import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { postGrnAndRollup } from '../src/scm/routes/grns';
import { STOCK_TX_ROLLED_BACK, stockTxOver } from '../src/scm/lib/stock-post-tx';

/* END-TO-END PROOF that a GRN POST — the status flip, the PO received recount,
 * the landed allocation and the stock IN (with the FIFO trigger it fires) —
 * COMMITS TOGETHER OR NOT AT ALL, against real Postgres (GRN_POST_MODE=atomic).
 *
 * Production found HC-GRN-2609-118 POSTED with no stock IN, and HC-GRN-2610-045
 * with a PO count that disagreed with its lines: each write was its own
 * PostgREST call. This drives the REAL postGrnAndRollup through the REAL
 * runner (stockTxOver) and the REAL pgTransactionSupabase shim, with production
 * postgres.js options. A trigger stands in for the FIFO trigger: it writes a lot
 * row, and raises on demand, so "the trigger ran inside the transaction" and
 * "a failure after the flip" are both real database events.
 *
 * The after-commit tail (reconciles, rack placement, SO allocation) runs on a
 * no-op client here: it is not part of the transaction by design.
 *
 * Runs against CI's postgres:16 service container (`backend-postgres` ->
 * `npm run test:pg`); SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

let sql: Sql;
const CO = 1;
const OTHER_CO = 2;

/* The after-commit client. Every call answers "nothing there". */
const noop: unknown = new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'then') return (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null, count: 0 }).then(ok);
    if (prop === 'maybeSingle' || prop === 'single') return async () => ({ data: null, error: null });
    if (prop === 'rpc') return async () => ({ data: null, error: null });
    return () => noop;
  },
});

const TABLES = ['grns', 'grn_items', 'purchase_order_items', 'purchase_orders', 'mfg_products', 'inventory_movements', 'test_fifo_lots'];

const grnStatus = async (id: string) => (await sql`SELECT status, posted_at FROM scm.grns WHERE id = ${id}`)[0] as { status: string; posted_at: Date | null };
const movements = async () => sql`SELECT movement_type, item_code, qty, movement_date::text AS movement_date, source_doc_id, batch_no, company_id FROM scm.inventory_movements ORDER BY id`;
const lots = async () => sql`SELECT item_code, qty FROM scm.test_fifo_lots`;
const received = async (poiId: string) => Number((await sql`SELECT received_qty FROM scm.purchase_order_items WHERE id = ${poiId}`)[0]!.received_qty);
const poStatus = async (poId: string) => (await sql`SELECT status FROM scm.purchase_orders WHERE id = ${poId}`)[0]!.status as string;

const post = (grnId: string, companyId: number, expected: string) =>
  postGrnAndRollup(noop, grnId, 'user-1', companyId, expected, stockTxOver(sql));

describePg('a GRN post is one transaction: flip, recount, allocation, stock IN', () => {
  beforeAll(async () => {
    sql = postgres(url, { max: 1, prepare: false, fetch_types: false, onnotice: () => {} });
    await sql`CREATE SCHEMA IF NOT EXISTS scm`;
    /* DROP before CREATE: other files in this suite build tables of these names
       with different column sets, and vitest does not order files. */
    for (const t of TABLES) await sql.unsafe(`DROP TABLE IF EXISTS scm.${t} CASCADE`);
    await sql`
      CREATE TABLE scm.grns (
        id text PRIMARY KEY, grn_number text, company_id bigint, status text NOT NULL,
        posted_at timestamptz, updated_at timestamptz, warehouse_id text,
        exchange_rate numeric(14,6) DEFAULT 1, allocation_method text DEFAULT 'QTY', received_at date
      )`;
    await sql`
      CREATE TABLE scm.grn_items (
        id text PRIMARY KEY, grn_id text, company_id bigint, purchase_order_item_id text,
        qty_accepted integer, item_code text, material_name text, unit_price_sen bigint,
        line_total_sen bigint, item_group text, variants jsonb, zero_cost_ack boolean DEFAULT false,
        returned_qty integer DEFAULT 0, returned_closed_qty integer DEFAULT 0, allocated_charge_sen bigint DEFAULT 0
      )`;
    await sql`
      CREATE TABLE scm.purchase_order_items (
        id text PRIMARY KEY, purchase_order_id text, qty integer, received_qty integer DEFAULT 0, warehouse_id text
      )`;
    await sql`
      CREATE TABLE scm.purchase_orders (
        id text PRIMARY KEY, po_number text, status text, company_id bigint,
        received_at timestamptz, updated_at timestamptz
      )`;
    await sql`CREATE TABLE scm.mfg_products (code text, unit_m3_milli integer, company_id bigint)`;
    await sql`
      CREATE TABLE scm.inventory_movements (
        id bigserial PRIMARY KEY, company_id bigint, movement_type text NOT NULL, warehouse_id text,
        item_code text, variant_key text, product_name text, qty numeric, unit_cost_sen bigint,
        batch_no text, movement_date date, source_doc_type text, source_doc_id text,
        source_doc_no text, performed_by text
      )`;
    await sql`CREATE TABLE scm.test_fifo_lots (item_code text, qty numeric)`;
    /* The FIFO trigger's stand-in: opens a lot per IN, raises for item BOOM. */
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION scm.test_fifo_in() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.item_code = 'BOOM' THEN RAISE EXCEPTION 'fifo trigger refused %', NEW.item_code; END IF;
        INSERT INTO scm.test_fifo_lots (item_code, qty) VALUES (NEW.item_code, NEW.qty);
        RETURN NEW;
      END $$`);
    await sql`CREATE TRIGGER test_fifo_in AFTER INSERT ON scm.inventory_movements FOR EACH ROW EXECUTE FUNCTION scm.test_fifo_in()`;
  });

  afterAll(async () => {
    for (const t of TABLES) await sql.unsafe(`DROP TABLE IF EXISTS scm.${t} CASCADE`);
    await sql`DROP FUNCTION IF EXISTS scm.test_fifo_in()`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql.unsafe(`TRUNCATE ${TABLES.map((t) => `scm.${t}`).join(', ')}`);
    await sql`
      INSERT INTO scm.grns (id, grn_number, company_id, status, warehouse_id, received_at) VALUES
        ('g-1', 'GRN-2611-001', ${CO}, 'DRAFT', 'wh-1', '2026-11-01'),
        ('g-boom', 'GRN-2611-002', ${CO}, 'DRAFT', 'wh-1', '2026-11-01'),
        ('g-other', '2990-GRN-2611-001', ${OTHER_CO}, 'DRAFT', 'wh-9', '2026-11-01')`;
    await sql`
      INSERT INTO scm.grn_items (id, grn_id, company_id, purchase_order_item_id, qty_accepted, item_code, material_name, unit_price_sen, line_total_sen, item_group) VALUES
        ('gi-1', 'g-1', ${CO}, 'poi-1', 3, 'SKU-1', 'Chair', 10000, 30000, 'chair'),
        ('gi-b', 'g-boom', ${CO}, 'poi-b', 2, 'BOOM', 'Table', 20000, 40000, 'table'),
        ('gi-o', 'g-other', ${OTHER_CO}, 'poi-o', 4, 'SKU-9', 'Sofa', 50000, 200000, 'sofa')`;
    await sql`
      INSERT INTO scm.purchase_order_items (id, purchase_order_id, qty, received_qty, warehouse_id) VALUES
        ('poi-1', 'po-1', 3, 0, 'wh-1'), ('poi-b', 'po-b', 2, 0, 'wh-1'), ('poi-o', 'po-o', 4, 0, 'wh-9')`;
    await sql`
      INSERT INTO scm.purchase_orders (id, po_number, status, company_id) VALUES
        ('po-1', 'PO-2611-001', 'SUBMITTED', ${CO}), ('po-b', 'PO-2611-002', 'SUBMITTED', ${CO}),
        ('po-o', '2990-PO-2611-001', 'SUBMITTED', ${OTHER_CO})`;
  });

  test('COMMIT: POSTED, stock IN on the received date, lot opened, PO recounted', async () => {
    const res = await post('g-1', CO, 'DRAFT');
    expect(res.ok).toBe(true);
    const g = await grnStatus('g-1');
    expect(g.status).toBe('POSTED');
    expect(g.posted_at).not.toBeNull();
    const m = await movements();
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ movement_type: 'IN', item_code: 'SKU-1', movement_date: '2026-11-01', source_doc_id: 'g-1', batch_no: 'PO-2611-001' });
    expect(Number(m[0]!.qty)).toBe(3);
    expect(Number(m[0]!.company_id)).toBe(CO);
    expect(await lots()).toHaveLength(1);
    expect(await received('poi-1')).toBe(3);
    expect(await poStatus('po-1')).toBe('RECEIVED');
  });

  test('ROLLBACK: the FIFO trigger refusing the IN leaves the GRN DRAFT, the PO count and every row as they were', async () => {
    const res = await post('g-boom', CO, 'DRAFT');
    expect(res).toMatchObject({ ok: false, reason: STOCK_TX_ROLLED_BACK });
    const g = await grnStatus('g-boom');
    expect(g.status).toBe('DRAFT');
    expect(g.posted_at).toBeNull();
    expect(await movements()).toHaveLength(0);
    expect(await lots()).toHaveLength(0);
    /* The recount ran before the IN, inside the same transaction: it is undone too. */
    expect(await received('poi-b')).toBe(0);
    expect(await poStatus('po-b')).toBe('SUBMITTED');
  });

  test('ROLLBACK: a PO write refused after the flip takes the flip with it', async () => {
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION scm.test_po_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'po write refused'; END $$`);
    await sql`CREATE TRIGGER test_po_refuse BEFORE UPDATE ON scm.purchase_orders FOR EACH ROW EXECUTE FUNCTION scm.test_po_refuse()`;
    try {
      const res = await post('g-1', CO, 'DRAFT');
      expect(res).toMatchObject({ ok: false, reason: STOCK_TX_ROLLED_BACK });
      expect((await grnStatus('g-1')).status).toBe('DRAFT');
      expect(await received('poi-1')).toBe(0);
      expect(await movements()).toHaveLength(0);
    } finally {
      await sql`DROP TRIGGER IF EXISTS test_po_refuse ON scm.purchase_orders`;
      await sql`DROP FUNCTION IF EXISTS scm.test_po_refuse()`;
    }
  });

  test('company scope: another company\'s GRN id is not posted and nothing moves', async () => {
    const res = await post('g-other', CO, 'DRAFT');
    expect(res.ok).toBe(false);
    expect((await grnStatus('g-other')).status).toBe('DRAFT');
    expect(await movements()).toHaveLength(0);
    expect(await received('poi-o')).toBe(0);
  });

  test('idempotent retry: the second post books no second IN', async () => {
    expect((await post('g-1', CO, 'DRAFT')).ok).toBe(true);
    expect(await post('g-1', CO, 'DRAFT')).toMatchObject({ ok: false, reason: 'already_posting', status: 409 });
    expect((await post('g-1', CO, 'POSTED')).ok).toBe(true);
    expect(await movements()).toHaveLength(1);
    expect(await lots()).toHaveLength(1);
    expect(await received('poi-1')).toBe(3);
  });

  test('a rolled-back post can be retried once the cause is gone', async () => {
    await sql`UPDATE scm.grn_items SET item_code = 'BOOM' WHERE id = 'gi-1'`;
    expect((await post('g-1', CO, 'DRAFT')).ok).toBe(false);
    await sql`UPDATE scm.grn_items SET item_code = 'SKU-1' WHERE id = 'gi-1'`;
    expect((await post('g-1', CO, 'DRAFT')).ok).toBe(true);
    expect(await movements()).toHaveLength(1);
  });
});
