import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { STOCK_TX_ROLLED_BACK, stockTxFor, stockTxOver, type StockTxClient } from '../src/scm/lib/stock-post-tx';
import {
  cancelDrAtomically, drResyncCore, drStockInCore, isDrFlipMiss, receiveCreatedDrAtomically, type DrFlip,
} from '../src/scm/lib/delivery-return-stock';
import { computeVariantKey } from '../src/scm/shared';
import { autocommitClient } from './lib/autocommit-client';

/* END-TO-END PROOF that a customer return's stock writes COMMIT TOGETHER OR NOT
 * AT ALL, against real Postgres (DELIVERY_RETURN_MODE=atomic):
 *   - the create's stock IN (the FIFO trigger fires on it), or none, and the
 *     just-created return removed again when it rolled back;
 *   - the cancel's status flip and its drain of the booked units, or neither.
 *
 * This drives the REAL cores (lib/delivery-return-stock.ts) through the REAL
 * runner (stockTxOver) and the REAL pgTransactionSupabase shim, with production
 * postgres.js options (src/db/pg.ts, bigint as a number included: company 1 is
 * told apart by `companyId === 1`, so a bigint read back as '1' would send a
 * company-1 return down company 2's bucket-key path, #5617). A trigger stands in
 * for the FIFO trigger: it opens a lot row per movement, and raises for item
 * BOOM (any movement) and BOOM-ADJ (a resync ADJUSTMENT only), so "a failure
 * after the flip" is a real database event.
 *
 * The two-step path (the rollback switch) runs over autocommitClient: the same
 * statements, each committed on its own, as PostgREST does.
 *
 * Runs against CI's postgres:16 service container (`backend-postgres` ->
 * `npm run test:pg`); SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

let sql: Sql;
const CO = 1;
const OTHER_CO = 2;

const TABLES = ['delivery_returns', 'delivery_return_items', 'delivery_order_items', 'delivery_orders', 'mfg_sales_order_items', 'warehouses',
  'inventory_movements', 'test_fifo_lots', 'mfg_products', 'inventory_balances', 'inventory_lot_consumptions'];

const statusOf = async (id: string) => ((await sql`SELECT status FROM scm.delivery_returns WHERE id = ${id}`)[0]?.status as string | undefined);
const linesOf = async (id: string) => Number((await sql`SELECT count(*)::int AS n FROM scm.delivery_return_items WHERE delivery_return_id = ${id}`)[0]!.n);
const movs = async () => sql`SELECT movement_type, item_code, qty, unit_cost_sen, source_doc_type, source_doc_id, company_id, variant_key, batch_no, warehouse_id FROM scm.inventory_movements ORDER BY id`;
const lots = async () => sql`SELECT item_code FROM scm.test_fifo_lots`;

const flipCancel = (companyId: number, id: string, prev = 'RECEIVED'): DrFlip => async (t: StockTxClient) => {
  const { data } = await t.from('delivery_returns').update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
    .eq('id', id).eq('company_id', companyId).eq('status', prev).select('id, status').maybeSingle();
  return { data: (data as { id: string; status: string } | null) ?? null, error: null };
};
const receive = (id: string, no: string, companyId: number) =>
  receiveCreatedDrAtomically(stockTxOver(sql), autocommitClient(sql), id, no, companyId, 'user-1');

/* A return already received (its IN booked), ready to cancel. */
async function booked(id: string, item: string, companyId = CO) {
  await sql`
    INSERT INTO scm.inventory_movements (company_id, movement_type, warehouse_id, item_code, variant_key, qty, unit_cost_sen, source_doc_type, source_doc_id, source_doc_no, product_name)
    VALUES (${companyId}, 'IN', 'wh-1', ${item}, '', 2, 5000, 'DR', ${id}, ${id}, 'x')`;
}

describePg('a customer return is one transaction: create IN, cancel flip + drain', () => {
  beforeAll(async () => {
    sql = postgres(url, {
      max: 1, prepare: false, fetch_types: false, onnotice: () => {},
      types: { bigint: { to: 20, from: [20], parse: (x: string) => Number(x), serialize: (x: number | string) => String(x) } },
    });
    await sql`CREATE SCHEMA IF NOT EXISTS scm`;
    /* DROP before CREATE: other files build tables of these names with other columns. */
    for (const t of TABLES) await sql.unsafe(`DROP TABLE IF EXISTS scm.${t} CASCADE`);
    await sql`
      CREATE TABLE scm.delivery_returns (
        id text PRIMARY KEY, return_number text, company_id bigint, status text NOT NULL,
        warehouse_id text, delivery_order_id text, updated_at timestamptz
      )`;
    await sql`
      CREATE TABLE scm.delivery_return_items (
        id text PRIMARY KEY, delivery_return_id text, company_id bigint, do_item_id text, item_code text,
        description text, qty_returned integer, item_group text, variants jsonb, unit_cost_sen bigint
      )`;
    await sql`CREATE TABLE scm.delivery_order_items (id text PRIMARY KEY, so_item_id text, delivery_order_id text)`;
    await sql`CREATE TABLE scm.delivery_orders (id text PRIMARY KEY, warehouse_id text, so_doc_no text)`;
    await sql`CREATE TABLE scm.mfg_sales_order_items (id text PRIMARY KEY, warehouse_id text, allocated_batch_no text)`;
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
    await sql`CREATE TABLE scm.inventory_lot_consumptions (source_doc_type text, source_doc_id text, lot_id text, item_code text, variant_key text, qty_consumed numeric)`;
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION scm.test_fifo_dr() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.item_code = 'BOOM' OR (NEW.item_code = 'BOOM-ADJ' AND NEW.source_doc_type = 'ADJUSTMENT') THEN
          RAISE EXCEPTION 'fifo trigger refused %', NEW.item_code;
        END IF;
        INSERT INTO scm.test_fifo_lots (item_code) VALUES (NEW.item_code);
        RETURN NEW;
      END $$`);
    await sql`CREATE TRIGGER test_fifo_dr AFTER INSERT ON scm.inventory_movements FOR EACH ROW EXECUTE FUNCTION scm.test_fifo_dr()`;
  });

  afterAll(async () => {
    for (const t of TABLES) await sql.unsafe(`DROP TABLE IF EXISTS scm.${t} CASCADE`);
    await sql`DROP FUNCTION IF EXISTS scm.test_fifo_dr()`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql.unsafe(`TRUNCATE ${TABLES.map((t) => `scm.${t}`).join(', ')}`);
    await sql`
      INSERT INTO scm.delivery_returns (id, return_number, company_id, status, warehouse_id) VALUES
        ('dr-1', 'HC-DR-2611-001', ${CO}, 'RECEIVED', 'wh-1'),
        ('dr-boom', 'HC-DR-2611-002', ${CO}, 'RECEIVED', 'wh-1'),
        ('dr-o', '2990-DR-2611-001', ${OTHER_CO}, 'RECEIVED', 'wh-9')`;
    await sql`
      INSERT INTO scm.delivery_return_items (id, delivery_return_id, company_id, do_item_id, item_code, description, qty_returned, item_group, unit_cost_sen) VALUES
        ('r1', 'dr-1', ${CO}, 'dl-1', 'CHAIR-1', 'Chair', 2, 'chair', 5000),
        ('rb1', 'dr-boom', ${CO}, 'dl-1', 'CHAIR-1', 'Chair', 1, 'chair', 5000),
        ('rb2', 'dr-boom', ${CO}, 'dl-1', 'BOOM', 'Table', 1, 'table', 7000),
        ('ro', 'dr-o', ${OTHER_CO}, 'dl-o', 'SOFA-9', 'Sofa', 1, 'sofa', 9000)`;
    await sql`INSERT INTO scm.delivery_order_items (id, so_item_id, delivery_order_id) VALUES ('dl-1', NULL, 'do-1'), ('dl-o', NULL, 'do-o')`;
    await sql`INSERT INTO scm.delivery_orders (id, warehouse_id) VALUES ('do-1', 'wh-1'), ('do-o', 'wh-9')`;
  });

  test('COMMIT create: the IN at the line cost, its lot opened, the return kept', async () => {
    const res = await receive('dr-1', 'HC-DR-2611-001', CO);
    expect(res.ok).toBe(true);
    const m = await movs();
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ movement_type: 'IN', item_code: 'CHAIR-1', source_doc_type: 'DR', source_doc_id: 'dr-1', warehouse_id: 'wh-1', company_id: CO, unit_cost_sen: 5000 });
    expect(Number(m[0]!.qty)).toBe(2);
    expect(await lots()).toHaveLength(1);
    expect(await statusOf('dr-1')).toBe('RECEIVED');
  });

  test('ROLLBACK create: one line refused leaves no IN and no lot, and the return and its lines are removed', async () => {
    const res = await receive('dr-boom', 'HC-DR-2611-002', CO);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.removed).toBe(true);
    expect((res.body as { error: string }).error).toBe(STOCK_TX_ROLLED_BACK);
    expect(await movs()).toHaveLength(0);
    expect(await lots()).toHaveLength(0);
    expect(await statusOf('dr-boom')).toBeUndefined();
    expect(await linesOf('dr-boom')).toBe(0);
    // The clean-up is company-scoped and by id: nothing else went.
    expect(await statusOf('dr-1')).toBe('RECEIVED');
    expect(await statusOf('dr-o')).toBe('RECEIVED');
  });

  test('#5619 inside the transaction: a company-1 hard-bound line re-enters the PO lot its DO shipped from', async () => {
    const vk = computeVariantKey('bedframe', null);
    await sql`INSERT INTO scm.delivery_returns (id, return_number, company_id, status, warehouse_id) VALUES ('dr-hb', 'HC-DR-2611-003', ${CO}, 'RECEIVED', 'wh-1')`;
    await sql`INSERT INTO scm.delivery_return_items (id, delivery_return_id, company_id, do_item_id, item_code, description, qty_returned, item_group, unit_cost_sen) VALUES ('rhb', 'dr-hb', ${CO}, 'dl-1', 'BF-1', 'Bedframe', 1, 'bedframe', 30000)`;
    await sql`
      INSERT INTO scm.inventory_movements (company_id, movement_type, warehouse_id, item_code, variant_key, qty, source_doc_type, source_doc_id, batch_no)
      VALUES (${CO}, 'OUT', 'wh-1', 'BF-1', ${vk}, 1, 'DO', 'do-1', 'HC-PO-2611-007')`;
    expect((await receive('dr-hb', 'HC-DR-2611-003', CO)).ok).toBe(true);
    const ins = (await movs()).filter((m) => m.source_doc_type === 'DR');
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ item_code: 'BF-1', batch_no: 'HC-PO-2611-007' });
  });

  test('#5617 inside the transaction: a company-2 return books into the stocked bucket\'s own key', async () => {
    const stored = 'fabriccode=bf16|gap=4|legheight=2';
    await sql`INSERT INTO scm.delivery_returns (id, return_number, company_id, status, warehouse_id) VALUES ('dr-c2', '2990-DR-2611-002', ${OTHER_CO}, 'RECEIVED', 'wh-2')`;
    await sql`INSERT INTO scm.delivery_orders (id, warehouse_id) VALUES ('do-c2', 'wh-2')`;
    await sql`INSERT INTO scm.delivery_order_items (id, so_item_id, delivery_order_id) VALUES ('dl-c2', NULL, 'do-c2')`;
    await sql`
      INSERT INTO scm.delivery_return_items (id, delivery_return_id, company_id, do_item_id, item_code, description, qty_returned, item_group, variants, unit_cost_sen)
      VALUES ('rc2', 'dr-c2', ${OTHER_CO}, 'dl-c2', 'BF-1', 'Bedframe', 1, 'bedframe', ${sql.json({ fabricCode: 'BF-16', gap: '4"', legHeight: '2"', totalHeight: '6"' })}, 30000)`;
    await sql`INSERT INTO scm.mfg_products (code, category, company_id) VALUES ('BF-1', 'bedframe', ${OTHER_CO})`;
    await sql`INSERT INTO scm.inventory_balances (warehouse_id, item_code, variant_key, qty, company_id) VALUES ('wh-2', 'BF-1', ${stored}, 3, ${OTHER_CO})`;
    expect((await receive('dr-c2', '2990-DR-2611-002', OTHER_CO)).ok).toBe(true);
    const m = await movs();
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ item_code: 'BF-1', variant_key: stored, company_id: OTHER_CO });
  });

  test('COMMIT cancel: CANCELLED and the booked units drained', async () => {
    await booked('dr-1', 'CHAIR-1');
    const res = await cancelDrAtomically(stockTxOver(sql), 'dr-1', 'user-1', flipCancel(CO, 'dr-1'));
    expect(res.ok).toBe(true);
    expect(await statusOf('dr-1')).toBe('CANCELLED');
    const adj = (await movs()).filter((m) => m.source_doc_type === 'ADJUSTMENT');
    expect(adj).toHaveLength(1);
    expect(adj[0]).toMatchObject({ movement_type: 'ADJUSTMENT', item_code: 'CHAIR-1', source_doc_id: 'dr-1' });
    expect(Number(adj[0]!.qty)).toBe(-2);
  });

  test('ROLLBACK cancel: a drain refused after the flip leaves the return RECEIVED and the stock booked', async () => {
    await booked('dr-boom', 'BOOM-ADJ');
    const res = await cancelDrAtomically(stockTxOver(sql), 'dr-boom', 'user-1', flipCancel(CO, 'dr-boom'));
    expect(res).toMatchObject({ ok: false, reason: STOCK_TX_ROLLED_BACK });
    expect(await statusOf('dr-boom')).toBe('RECEIVED');
    expect((await movs()).filter((m) => m.source_doc_type === 'ADJUSTMENT')).toHaveLength(0);
  });

  test('company scope: another company\'s return is not cancelled and nothing is drained', async () => {
    await booked('dr-o', 'SOFA-9', OTHER_CO);
    const res = await cancelDrAtomically(stockTxOver(sql), 'dr-o', 'user-1', flipCancel(CO, 'dr-o'));
    expect(isDrFlipMiss(res)).toBe(true);
    expect(await statusOf('dr-o')).toBe('RECEIVED');
    expect((await movs()).filter((m) => m.source_doc_type === 'ADJUSTMENT')).toHaveLength(0);
  });

  test('safe retry: no second IN, no second drain; a rolled-back cancel can be retried once the cause is gone', async () => {
    expect((await receive('dr-1', 'HC-DR-2611-001', CO)).ok).toBe(true);
    expect((await receive('dr-1', 'HC-DR-2611-001', CO)).ok).toBe(true);
    expect((await movs()).filter((m) => m.source_doc_type === 'DR')).toHaveLength(1);
    expect((await cancelDrAtomically(stockTxOver(sql), 'dr-1', 'user-1', flipCancel(CO, 'dr-1'))).ok).toBe(true);
    expect(isDrFlipMiss(await cancelDrAtomically(stockTxOver(sql), 'dr-1', 'user-1', flipCancel(CO, 'dr-1')))).toBe(true);
    expect((await movs()).filter((m) => m.source_doc_type === 'ADJUSTMENT')).toHaveLength(1);

    await booked('dr-boom', 'BOOM-ADJ');
    expect((await cancelDrAtomically(stockTxOver(sql), 'dr-boom', 'user-1', flipCancel(CO, 'dr-boom'))).ok).toBe(false);
    await sql`UPDATE scm.inventory_movements SET item_code = 'CHAIR-2' WHERE source_doc_id = 'dr-boom'`;
    expect((await cancelDrAtomically(stockTxOver(sql), 'dr-boom', 'user-1', flipCancel(CO, 'dr-boom'))).ok).toBe(true);
    expect(await statusOf('dr-boom')).toBe('CANCELLED');
  });

  test('two-step (the rollback switch) is still the old path: each write commits on its own', async () => {
    expect(stockTxFor({ DELIVERY_RETURN_MODE: 'two-step', DATABASE_URL: url }, 'DELIVERY_RETURN_MODE')).toBeNull();
    const db = autocommitClient(sql);
    // The create's IN alone, as before.
    expect((await drStockInCore(db, 'dr-1', 'user-1')).errors).toEqual([]);
    expect((await movs()).filter((m) => m.source_doc_type === 'DR')).toHaveLength(1);
    // The cancel: the flip commits, then the refused drain is REPORTED and the flip stands.
    await booked('dr-boom', 'BOOM-ADJ');
    const { data } = await (db as { from: (t: string) => any }).from('delivery_returns') // eslint-disable-line @typescript-eslint/no-explicit-any -- the recorded client
      .update({ status: 'CANCELLED' }).eq('id', 'dr-boom').eq('company_id', CO).eq('status', 'RECEIVED').select('id').maybeSingle();
    expect(data).toBeTruthy();
    const drain = await drResyncCore(db, 'dr-boom', 'user-1');
    expect(drain.errors[0]).toContain('fifo trigger refused');
    expect(await statusOf('dr-boom')).toBe('CANCELLED');
  });
});
