import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { shipDoAtomically } from '../src/scm/routes/delivery-orders-mfg';
import { STOCK_TX_ROLLED_BACK, stockTxOver, type StockTxClient } from '../src/scm/lib/stock-post-tx';
import type { DoShipFlip } from '../src/scm/lib/do-ship-atomic';

/* END-TO-END PROOF that a DO's FIRST SHIP — the status flip, the stock OUT (with
 * the FIFO trigger it fires) and the rack STOCK_OUT — COMMITS TOGETHER OR NOT AT
 * ALL, against real Postgres (DO_SHIP_MODE=atomic).
 *
 * HC-DO-2610-319 shipped with 4 lines and no OUT: each write was its own
 * PostgREST call. This drives the REAL shipDoAtomically (and the real deduction
 * inside it) through the REAL runner (stockTxOver) and the REAL
 * pgTransactionSupabase shim, with production postgres.js options. The flip is
 * the handler's statement shape: CAS on the status read, scoped to the company.
 * A trigger stands in for the FIFO trigger: it opens a lot row, and raises for
 * item BOOM, so "a failure after the flip" is a real database event.
 *
 * The after-commit tail (cost restamp, SO allocation, shipped-from stamp) runs
 * on a no-op client: it is outside the transaction by design.
 *
 * Runs against CI's postgres:16 service container (`backend-postgres` ->
 * `npm run test:pg`); SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

let sql: Sql;
const CO = 1;
const OTHER_CO = 2;

const noop: unknown = new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'then') return (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null, count: 0 }).then(ok);
    if (prop === 'maybeSingle' || prop === 'single') return async () => ({ data: null, error: null });
    if (prop === 'rpc') return async () => ({ data: null, error: null });
    return () => noop;
  },
});

const TABLES = ['delivery_orders', 'delivery_order_items', 'mfg_sales_order_items', 'warehouses', 'warehouse_racks', 'warehouse_rack_items', 'warehouse_rack_movements', 'inventory_movements', 'test_fifo_lots'];

const flip = (companyId: number, id: string): DoShipFlip => async (t: StockTxClient) => {
  const { data } = await t.from('delivery_orders').update({ status: 'LOADED', updated_at: new Date().toISOString() })
    .eq('id', id).eq('company_id', companyId).eq('status', 'DRAFT').select('id, status').maybeSingle();
  return data ? { ok: true, data: data as { id: string; status: string } } : { ok: false, reason: 'status_changed' };
};
const ship = (id: string, companyId: number, withFlip = true) =>
  shipDoAtomically(stockTxOver(sql), noop, id, 'user-1', withFlip ? flip(companyId, id) : null);

const statusOf = async (id: string) => (await sql`SELECT status FROM scm.delivery_orders WHERE id = ${id}`)[0]!.status as string;
const outs = async () => sql`SELECT movement_type, item_code, qty, source_doc_id, company_id FROM scm.inventory_movements ORDER BY id`;
const lots = async () => sql`SELECT item_code FROM scm.test_fifo_lots`;
const rackOuts = async () => sql`SELECT rack_id, quantity, source_doc_no FROM scm.warehouse_rack_movements`;
const rackQty = async () => Number((await sql`SELECT qty FROM scm.warehouse_rack_items WHERE id = 'ri1'`)[0]?.qty ?? 0);

describePg('a DO first ship is one transaction: flip, stock OUT, rack STOCK_OUT', () => {
  beforeAll(async () => {
    sql = postgres(url, { max: 1, prepare: false, fetch_types: false, onnotice: () => {} });
    await sql`CREATE SCHEMA IF NOT EXISTS scm`;
    for (const t of TABLES) await sql.unsafe(`DROP TABLE IF EXISTS scm.${t} CASCADE`);
    await sql`
      CREATE TABLE scm.delivery_orders (
        id text PRIMARY KEY, do_number text, company_id bigint, status text NOT NULL, so_doc_no text,
        warehouse_id text, is_dropship boolean DEFAULT false, migrated_no_stock boolean DEFAULT false, updated_at timestamptz
      )`;
    await sql`
      CREATE TABLE scm.delivery_order_items (
        id text PRIMARY KEY, delivery_order_id text, company_id bigint, so_item_id text, item_code text,
        description text, qty integer, item_group text, variants jsonb, rack_id text, committed_po_batch_no text
      )`;
    await sql`CREATE TABLE scm.mfg_sales_order_items (id text PRIMARY KEY, warehouse_id text, allocated_batch_no text)`;
    await sql`CREATE TABLE scm.warehouses (id text PRIMARY KEY, code text, company_id bigint, is_default boolean)`;
    await sql`CREATE TABLE scm.warehouse_racks (id text PRIMARY KEY, rack text, warehouse_id text, company_id bigint, reserved boolean DEFAULT false, status text, updated_at timestamptz)`;
    await sql`CREATE TABLE scm.warehouse_rack_items (id text PRIMARY KEY, rack_id text, item_code text, qty integer, stocked_in_date date, company_id bigint)`;
    await sql`
      CREATE TABLE scm.warehouse_rack_movements (
        id bigserial PRIMARY KEY, company_id bigint, movement_type text, rack_id text, rack_label text, warehouse_id text,
        item_code text, product_name text, source_doc_no text, quantity integer, reason text, performed_by text
      )`;
    await sql`
      CREATE TABLE scm.inventory_movements (
        id bigserial PRIMARY KEY, company_id bigint, movement_type text NOT NULL, warehouse_id text,
        item_code text, variant_key text, product_name text, qty numeric, unit_cost_sen bigint,
        batch_no text, movement_date date, source_doc_type text, source_doc_id text,
        source_doc_no text, performed_by text
      )`;
    await sql`CREATE TABLE scm.test_fifo_lots (item_code text)`;
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION scm.test_fifo_out() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.item_code = 'BOOM' THEN RAISE EXCEPTION 'fifo trigger refused %', NEW.item_code; END IF;
        INSERT INTO scm.test_fifo_lots (item_code) VALUES (NEW.item_code);
        RETURN NEW;
      END $$`);
    await sql`CREATE TRIGGER test_fifo_out AFTER INSERT ON scm.inventory_movements FOR EACH ROW EXECUTE FUNCTION scm.test_fifo_out()`;
  });

  afterAll(async () => {
    for (const t of TABLES) await sql.unsafe(`DROP TABLE IF EXISTS scm.${t} CASCADE`);
    await sql`DROP FUNCTION IF EXISTS scm.test_fifo_out()`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql.unsafe(`TRUNCATE ${TABLES.map((t) => `scm.${t}`).join(', ')}`);
    await sql`
      INSERT INTO scm.delivery_orders (id, do_number, company_id, status, warehouse_id) VALUES
        ('do-1', 'HC-DO-2611-001', ${CO}, 'DRAFT', 'wh-1'),
        ('do-boom', 'HC-DO-2611-002', ${CO}, 'DRAFT', 'wh-1'),
        ('do-o', '2990-DO-2611-001', ${OTHER_CO}, 'DRAFT', 'wh-9')`;
    await sql`
      INSERT INTO scm.delivery_order_items (id, delivery_order_id, company_id, item_code, description, qty, item_group) VALUES
        ('l1', 'do-1', ${CO}, 'CHAIR-1', 'Chair', 2, 'chair'),
        ('lb1', 'do-boom', ${CO}, 'CHAIR-1', 'Chair', 1, 'chair'),
        ('lb2', 'do-boom', ${CO}, 'BOOM', 'Table', 1, 'table'),
        ('lo', 'do-o', ${OTHER_CO}, 'SOFA-9', 'Sofa', 1, 'sofa')`;
    await sql`INSERT INTO scm.warehouse_racks (id, rack, warehouse_id, company_id) VALUES ('r1', 'A-01', 'wh-1', ${CO})`;
    await sql`INSERT INTO scm.warehouse_rack_items (id, rack_id, item_code, qty, stocked_in_date, company_id) VALUES ('ri1', 'r1', 'CHAIR-1', 5, '2026-10-01', ${CO})`;
  });

  test('COMMIT: LOADED, the OUT row (trigger ran), the rack STOCK_OUT', async () => {
    const res = await ship('do-1', CO);
    expect(res.ok).toBe(true);
    expect(await statusOf('do-1')).toBe('LOADED');
    const m = await outs();
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ movement_type: 'OUT', item_code: 'CHAIR-1', source_doc_id: 'do-1' });
    expect(Number(m[0]!.qty)).toBe(2);
    expect(Number(m[0]!.company_id)).toBe(CO);
    expect(await lots()).toHaveLength(1);
    expect(await rackOuts()).toHaveLength(1);
    expect(await rackQty()).toBe(3);
  });

  test('ROLLBACK: the FIFO trigger refusing one line leaves the DO DRAFT with no OUT and the rack as it was', async () => {
    const res = await ship('do-boom', CO);
    expect(res).toMatchObject({ ok: false, reason: STOCK_TX_ROLLED_BACK });
    expect(await statusOf('do-boom')).toBe('DRAFT');
    expect(await outs()).toHaveLength(0);
    expect(await lots()).toHaveLength(0);
    expect(await rackOuts()).toHaveLength(0);
    expect(await rackQty()).toBe(5);
  });

  test('company scope: another company\'s DO is not flipped and nothing moves', async () => {
    const res = await ship('do-o', CO);
    expect(res).toMatchObject({ ok: false, reason: 'status_changed' });
    expect(await statusOf('do-o')).toBe('DRAFT');
    expect(await outs()).toHaveLength(0);
  });

  test('idempotent retry: no second OUT, no second rack STOCK_OUT', async () => {
    expect((await ship('do-1', CO)).ok).toBe(true);
    expect(await ship('do-1', CO)).toMatchObject({ ok: false, reason: 'status_changed' });
    expect((await ship('do-1', CO, false)).ok).toBe(true);
    expect(await outs()).toHaveLength(1);
    expect(await rackOuts()).toHaveLength(1);
    expect(await rackQty()).toBe(3);
  });

  test('a rolled-back ship can be retried once the cause is gone', async () => {
    expect((await ship('do-boom', CO)).ok).toBe(false);
    await sql`UPDATE scm.delivery_order_items SET item_code = 'CHAIR-1' WHERE id = 'lb2'`;
    expect((await ship('do-boom', CO)).ok).toBe(true);
    expect(await statusOf('do-boom')).toBe('LOADED');
    expect(await outs()).toHaveLength(1); // the two CHAIR-1 lines collapse into one bucket
  });
});
