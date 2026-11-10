import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { STOCK_TX_ROLLED_BACK, stockTxFor, stockTxOver, type StockTxClient } from '../src/scm/lib/stock-post-tx';
import {
  cancelPrAtomically, isPrFlipMiss, postCreatedPrAtomically, prStockOutCore, recountGrnLines, type PrFlipResult,
} from '../src/scm/lib/purchase-return-stock';
import { autocommitClient } from './lib/autocommit-client';

/* END-TO-END PROOF that a supplier return's writes COMMIT TOGETHER OR NOT AT
 * ALL, against real Postgres (PURCHASE_RETURN_MODE=atomic):
 *   - create: the stock OUT (the FIFO trigger fires on it), the GRN line's
 *     returned_qty / returned_closed_qty and the PO line's received_qty recount,
 *     or none of them, and the just-created return removed again;
 *   - cancel: the flip to CANCELLED, the reversing IN (same lot, same cost) and
 *     the recount that releases the lines, or none of them.
 *
 * Drives the REAL cores (lib/purchase-return-stock.ts, and through them the real
 * recomputePoReceived and reverseMovementsCore) through the REAL runner and the
 * REAL pgTransactionSupabase shim, with production postgres.js options
 * (src/db/pg.ts bigint conversion: `companyId === 1` must hold for a bigint
 * read back, #5617). A trigger stands in for the FIFO trigger: it opens a lot
 * per movement and raises for item BOOM (any movement) and BOOM-REV (a
 * reversing IN only), so "a failure after the flip" is a real database event.
 *
 * The two-step path runs over autocommitClient: the same statements, each
 * committed on its own, as PostgREST does.
 *
 * Runs against CI's postgres:16 service container (`backend-postgres` ->
 * `npm run test:pg`); SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

let sql: Sql;
const CO = 1;
const OTHER_CO = 2;

const TABLES = ['purchase_returns', 'purchase_return_items', 'grns', 'grn_items', 'purchase_order_items', 'purchase_orders', 'warehouses',
  'inventory_movements', 'test_fifo_lots', 'mfg_products', 'inventory_balances'];

const statusOf = async (id: string) => ((await sql`SELECT status FROM scm.purchase_returns WHERE id = ${id}`)[0]?.status as string | undefined);
const linesOf = async (id: string) => Number((await sql`SELECT count(*)::int AS n FROM scm.purchase_return_items WHERE purchase_return_id = ${id}`)[0]!.n);
const prMovs = async () => sql`SELECT movement_type, item_code, qty, unit_cost_sen, batch_no, variant_key, warehouse_id, company_id FROM scm.inventory_movements WHERE source_doc_type = 'PURCHASE_RETURN' ORDER BY id`;
const lots = async () => Number((await sql`SELECT count(*)::int AS n FROM scm.test_fifo_lots`)[0]!.n);
const grnLine = async (id: string) => (await sql`SELECT returned_qty, returned_closed_qty FROM scm.grn_items WHERE id = ${id}`)[0] as { returned_qty: number; returned_closed_qty: number };
const received = async (id: string) => Number((await sql`SELECT received_qty FROM scm.purchase_order_items WHERE id = ${id}`)[0]!.received_qty);
const poStatus = async (id: string) => (await sql`SELECT status FROM scm.purchase_orders WHERE id = ${id}`)[0]!.status as string;

const post = (id: string, no: string, grnId: string, companyId: number, grnItemIds: string[]) =>
  postCreatedPrAtomically(stockTxOver(sql), autocommitClient(sql), { id, return_number: no }, grnId, companyId, 'user-1', grnItemIds);
const flipCancel = (companyId: number, id: string) => async (t: StockTxClient): Promise<PrFlipResult> => {
  const { data } = await t.from('purchase_returns').update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
    .eq('id', id).eq('company_id', companyId).neq('status', 'CANCELLED').neq('status', 'COMPLETED').select('id').maybeSingle();
  return { data: (data as { id: string } | null) ?? null, error: null };
};
const cancel = (id: string, companyId: number) => cancelPrAtomically(stockTxOver(sql), id, 'user-1', flipCancel(companyId, id));

describePg('a supplier return is one transaction: OUT + GRN returned + PO received, and its cancel', () => {
  beforeAll(async () => {
    sql = postgres(url, {
      max: 1, prepare: false, fetch_types: false, onnotice: () => {},
      types: { bigint: { to: 20, from: [20], parse: (x: string) => Number(x), serialize: (x: number | string) => String(x) } },
    });
    await sql`CREATE SCHEMA IF NOT EXISTS scm`;
    for (const t of TABLES) await sql.unsafe(`DROP TABLE IF EXISTS scm.${t} CASCADE`);
    await sql`
      CREATE TABLE scm.purchase_returns (
        id text PRIMARY KEY, return_number text, company_id bigint, status text NOT NULL, kind text DEFAULT 'CREDIT',
        repair_warehouse_id text, supplier_replaces boolean DEFAULT true, grn_id text, updated_at timestamptz
      )`;
    await sql`
      CREATE TABLE scm.purchase_return_items (
        id text PRIMARY KEY, purchase_return_id text, company_id bigint, grn_item_id text, item_code text,
        material_name text, qty_returned integer, item_group text, variants jsonb
      )`;
    await sql`CREATE TABLE scm.grns (id text PRIMARY KEY, warehouse_id text, status text, company_id bigint)`;
    await sql`
      CREATE TABLE scm.grn_items (
        id text PRIMARY KEY, grn_id text, purchase_order_item_id text, qty_accepted integer,
        returned_qty integer DEFAULT 0, returned_closed_qty integer DEFAULT 0
      )`;
    await sql`CREATE TABLE scm.purchase_order_items (id text PRIMARY KEY, purchase_order_id text, qty integer, received_qty integer)`;
    await sql`CREATE TABLE scm.purchase_orders (id text PRIMARY KEY, status text, received_at timestamptz, updated_at timestamptz)`;
    await sql`CREATE TABLE scm.warehouses (id text PRIMARY KEY, code text, company_id bigint, is_default boolean)`;
    await sql`
      CREATE TABLE scm.inventory_movements (
        id bigserial PRIMARY KEY, company_id bigint, movement_type text NOT NULL, warehouse_id text,
        item_code text, variant_key text, product_name text, qty numeric, unit_cost_sen bigint,
        batch_no text, movement_date date, source_doc_type text, source_doc_id text,
        source_doc_no text, performed_by text, notes text, correction_seq integer
      )`;
    await sql`CREATE TABLE scm.test_fifo_lots (item_code text)`;
    await sql`CREATE TABLE scm.mfg_products (code text, category text, company_id bigint)`;
    await sql`CREATE TABLE scm.inventory_balances (warehouse_id text, item_code text, variant_key text, qty numeric, company_id bigint)`;
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION scm.test_fifo_pr() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.item_code = 'BOOM'
           OR (NEW.item_code = 'BOOM-REV' AND NEW.source_doc_type = 'PURCHASE_RETURN' AND NEW.movement_type = 'IN') THEN
          RAISE EXCEPTION 'fifo trigger refused %', NEW.item_code;
        END IF;
        INSERT INTO scm.test_fifo_lots (item_code) VALUES (NEW.item_code);
        RETURN NEW;
      END $$`);
    await sql`CREATE TRIGGER test_fifo_pr AFTER INSERT ON scm.inventory_movements FOR EACH ROW EXECUTE FUNCTION scm.test_fifo_pr()`;
  });

  afterAll(async () => {
    for (const t of TABLES) await sql.unsafe(`DROP TABLE IF EXISTS scm.${t} CASCADE`);
    await sql`DROP FUNCTION IF EXISTS scm.test_fifo_pr()`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql.unsafe(`TRUNCATE ${TABLES.map((t) => `scm.${t}`).join(', ')}`);
    /* PO-1: 3 chairs received on GRN-1 (lot HC-PO-2611-001). Two returns of 1,
       inserted POSTED as the create does before its stock writes. */
    await sql`INSERT INTO scm.purchase_orders (id, status, received_at) VALUES ('po-1', 'RECEIVED', now()), ('po-o', 'RECEIVED', now())`;
    await sql`INSERT INTO scm.purchase_order_items (id, purchase_order_id, qty, received_qty) VALUES ('poi-1', 'po-1', 3, 3), ('poi-o', 'po-o', 1, 1)`;
    await sql`INSERT INTO scm.grns (id, warehouse_id, status, company_id) VALUES ('g-1', 'wh-1', 'POSTED', ${CO}), ('g-o', 'wh-9', 'POSTED', ${OTHER_CO})`;
    await sql`INSERT INTO scm.grn_items (id, grn_id, purchase_order_item_id, qty_accepted) VALUES ('gi-1', 'g-1', 'poi-1', 3), ('gi-o', 'g-o', 'poi-o', 1)`;
    await sql`
      INSERT INTO scm.inventory_movements (company_id, movement_type, warehouse_id, item_code, variant_key, qty, unit_cost_sen, batch_no, source_doc_type, source_doc_id, source_doc_no)
      VALUES (${CO}, 'IN', 'wh-1', 'CHAIR-1', '', 3, 10000, 'HC-PO-2611-001', 'GRN', 'g-1', 'HC-GRN-2611-001')`;
    await sql`
      INSERT INTO scm.purchase_returns (id, return_number, company_id, status, grn_id) VALUES
        ('pr-1', 'HC-PRT-2611-001', ${CO}, 'POSTED', 'g-1'),
        ('pr-boom', 'HC-PRT-2611-002', ${CO}, 'POSTED', 'g-1'),
        ('pr-o', '2990-PRT-2611-001', ${OTHER_CO}, 'POSTED', 'g-o')`;
    await sql`
      INSERT INTO scm.purchase_return_items (id, purchase_return_id, company_id, grn_item_id, item_code, material_name, qty_returned, item_group) VALUES
        ('pri-1', 'pr-1', ${CO}, 'gi-1', 'CHAIR-1', 'Chair', 1, 'chair'),
        ('pri-b1', 'pr-boom', ${CO}, NULL, 'CHAIR-1', 'Chair', 1, 'chair'),
        ('pri-b2', 'pr-boom', ${CO}, NULL, 'BOOM', 'Table', 1, 'table'),
        ('pri-o', 'pr-o', ${OTHER_CO}, 'gi-o', 'SOFA-9', 'Sofa', 1, 'sofa')`;
    await sql`TRUNCATE scm.test_fifo_lots`;
  });

  test('COMMIT create: the OUT from the GRN\'s own lot (#5619), returned_qty 1, PO line 2 of 3', async () => {
    const res = await post('pr-1', 'HC-PRT-2611-001', 'g-1', CO, ['gi-1']);
    expect(res).toMatchObject({ ok: true, wrote: true });
    const m = await prMovs();
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ movement_type: 'OUT', item_code: 'CHAIR-1', batch_no: 'HC-PO-2611-001', warehouse_id: 'wh-1', company_id: CO });
    expect(Number(m[0]!.qty)).toBe(1);
    expect(await lots()).toBe(1);
    expect((await grnLine('gi-1')).returned_qty).toBe(1);
    expect(await received('poi-1')).toBe(2);
    expect(await poStatus('po-1')).toBe('PARTIALLY_RECEIVED');
  });

  test('no replacement: closed on the GRN line, the PO stays RECEIVED, in the same commit', async () => {
    await sql`UPDATE scm.purchase_returns SET supplier_replaces = false WHERE id = 'pr-1'`;
    expect((await post('pr-1', 'HC-PRT-2611-001', 'g-1', CO, ['gi-1'])).ok).toBe(true);
    expect(await grnLine('gi-1')).toMatchObject({ returned_qty: 1, returned_closed_qty: 1 });
    expect(await received('poi-1')).toBe(3);
    expect(await poStatus('po-1')).toBe('RECEIVED');
  });

  test('ROLLBACK create: one line refused leaves no OUT, the GRN and PO as they were, and the return removed', async () => {
    const res = await post('pr-boom', 'HC-PRT-2611-002', 'g-1', CO, ['gi-1']);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.removed).toBe(true);
    expect((res.body as { error: string }).error).toBe(STOCK_TX_ROLLED_BACK);
    expect(await prMovs()).toHaveLength(0);
    expect(await lots()).toBe(0);
    expect((await grnLine('gi-1')).returned_qty).toBe(0);
    expect(await received('poi-1')).toBe(3);
    expect(await statusOf('pr-boom')).toBeUndefined();
    expect(await linesOf('pr-boom')).toBe(0);
    expect(await statusOf('pr-1')).toBe('POSTED');
    expect(await statusOf('pr-o')).toBe('POSTED');
  });

  test('ROLLBACK create: a PO write refused AFTER the OUT takes the OUT and the GRN count with it', async () => {
    await sql.unsafe(`CREATE OR REPLACE FUNCTION scm.test_po_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'po write refused'; END $$`);
    await sql`CREATE TRIGGER test_po_refuse BEFORE UPDATE ON scm.purchase_orders FOR EACH ROW EXECUTE FUNCTION scm.test_po_refuse()`;
    try {
      const res = await post('pr-1', 'HC-PRT-2611-001', 'g-1', CO, ['gi-1']);
      expect(res.ok).toBe(false);
      expect(await prMovs()).toHaveLength(0);
      expect((await grnLine('gi-1')).returned_qty).toBe(0);
      expect(await received('poi-1')).toBe(3);
    } finally {
      await sql`DROP TRIGGER IF EXISTS test_po_refuse ON scm.purchase_orders`;
      await sql`DROP FUNCTION IF EXISTS scm.test_po_refuse()`;
    }
  });

  test('#5617 inside the transaction: a company-2 OUT takes the stocked bucket\'s own key', async () => {
    const stored = 'fabriccode=bf16|gap=4|legheight=2';
    await sql`INSERT INTO scm.purchase_returns (id, return_number, company_id, status, grn_id) VALUES ('pr-c2', '2990-PRT-2611-002', ${OTHER_CO}, 'POSTED', 'g-o')`;
    await sql`
      INSERT INTO scm.purchase_return_items (id, purchase_return_id, company_id, grn_item_id, item_code, material_name, qty_returned, item_group, variants)
      VALUES ('pri-c2', 'pr-c2', ${OTHER_CO}, 'gi-o', 'BF-1', 'Bedframe', 1, 'bedframe', ${sql.json({ fabricCode: 'BF-16', gap: '4"', legHeight: '2"', totalHeight: '6"' })})`;
    await sql`INSERT INTO scm.mfg_products (code, category, company_id) VALUES ('BF-1', 'bedframe', ${OTHER_CO})`;
    await sql`INSERT INTO scm.inventory_balances (warehouse_id, item_code, variant_key, qty, company_id) VALUES ('wh-9', 'BF-1', ${stored}, 3, ${OTHER_CO})`;
    expect((await post('pr-c2', '2990-PRT-2611-002', 'g-o', OTHER_CO, ['gi-o'])).ok).toBe(true);
    const m = await prMovs();
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ item_code: 'BF-1', variant_key: stored, company_id: OTHER_CO, warehouse_id: 'wh-9' });
  });

  test('COMMIT cancel: CANCELLED, the OUT reversed into its lot at its cost, the lines released', async () => {
    expect((await post('pr-1', 'HC-PRT-2611-001', 'g-1', CO, ['gi-1'])).ok).toBe(true);
    const res = await cancel('pr-1', CO);
    expect(res.ok).toBe(true);
    expect(await statusOf('pr-1')).toBe('CANCELLED');
    const rev = (await prMovs()).filter((m) => m.movement_type === 'IN');
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({ batch_no: 'HC-PO-2611-001', warehouse_id: 'wh-1', company_id: CO });
    expect((await grnLine('gi-1')).returned_qty).toBe(0);
    expect(await received('poi-1')).toBe(3);
    expect(await poStatus('po-1')).toBe('RECEIVED');
  });

  test('ROLLBACK cancel: a reversing IN refused after the flip leaves the return POSTED, the stock out, the lines held', async () => {
    await sql`UPDATE scm.purchase_return_items SET item_code = 'BOOM-REV' WHERE id = 'pri-1'`;
    await sql`
      INSERT INTO scm.inventory_movements (company_id, movement_type, warehouse_id, item_code, variant_key, qty, unit_cost_sen, source_doc_type, source_doc_id, source_doc_no)
      VALUES (${CO}, 'OUT', 'wh-1', 'BOOM-REV', '', 1, 10000, 'PURCHASE_RETURN', 'pr-1', 'HC-PRT-2611-001')`;
    await sql`UPDATE scm.grn_items SET returned_qty = 1 WHERE id = 'gi-1'`;
    const res = await cancel('pr-1', CO);
    expect(res).toMatchObject({ ok: false, reason: STOCK_TX_ROLLED_BACK });
    expect(await statusOf('pr-1')).toBe('POSTED');
    expect((await prMovs()).filter((m) => m.movement_type === 'IN')).toHaveLength(0);
    expect((await grnLine('gi-1')).returned_qty).toBe(1);
  });

  test('company scope: another company\'s return is not cancelled and nothing moves', async () => {
    const res = await cancel('pr-o', CO);
    expect(isPrFlipMiss(res)).toBe(true);
    expect(await statusOf('pr-o')).toBe('POSTED');
    expect(await prMovs()).toHaveLength(0);
  });

  test('safe retry: no second reversal, and a rolled-back create can run again once the cause is gone', async () => {
    expect((await post('pr-1', 'HC-PRT-2611-001', 'g-1', CO, ['gi-1'])).ok).toBe(true);
    expect((await cancel('pr-1', CO)).ok).toBe(true);
    expect(isPrFlipMiss(await cancel('pr-1', CO))).toBe(true);
    expect((await prMovs()).filter((m) => m.movement_type === 'IN')).toHaveLength(1);
    expect((await recountGrnLines(autocommitClient(sql), ['gi-1'])).ok).toBe(true);
    expect((await grnLine('gi-1')).returned_qty).toBe(0);
  });

  test('two-step (the rollback switch) is still the old path: the OUT commits even when a later line is refused', async () => {
    expect(stockTxFor({ PURCHASE_RETURN_MODE: 'two-step', DATABASE_URL: url }, 'PURCHASE_RETURN_MODE')).toBeNull();
    const out = await prStockOutCore(autocommitClient(sql), 'pr-boom', 'HC-PRT-2611-002', 'g-1', 'user-1');
    expect(out.errors.join(' ')).toContain('fifo trigger refused');
    /* The OUT was refused, yet the old path's recount still commits on its own
       afterwards: pr-1's unit now counts as returned with no OUT behind it. */
    expect(await prMovs()).toHaveLength(0);
    expect((await recountGrnLines(autocommitClient(sql), ['gi-1'])).ok).toBe(true);
    expect((await grnLine('gi-1')).returned_qty).toBe(1);
  });
});
