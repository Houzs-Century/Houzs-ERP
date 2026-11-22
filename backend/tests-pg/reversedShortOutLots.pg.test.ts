import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

/* Symptom: cancelling a purchase return (or a stock transfer) whose stock-out was short put the FULL qty back into
 *   the FIFO lots, so the lots stood above the movement balance by the short.
 * Cause: scm.fn_inventory_movement_fifo opened a lot for every IN's full qty; only DO OUTs were ever repaired.
 * Fix (20261123T0100): a reversing IN names the OUT it undoes; for a non-DO OUT the lot is what that OUT consumed.
 *
 * The FIFO functions are the live ones, read out of 0307_item_code_unify.sql. Runs against CI's postgres:16
 * (`backend-postgres` -> `npm run test:pg`); skipped without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

async function fileEndingWith(suffix: string): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(suffix));
  if (files.length !== 1) throw new Error(`expected one *${suffix}, found ${files.length}`);
  return readFile(join(migrationsDir, files[0]!), 'utf8');
}

/** One CREATE OR REPLACE FUNCTION block out of a migration file. */
function functionBlock(sqlText: string, name: string): string {
  const start = sqlText.indexOf(`CREATE OR REPLACE FUNCTION scm.${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const open = sqlText.indexOf('$function$', start);
  const close = sqlText.indexOf('$function$;', open + 10);
  return sqlText.slice(start, close + '$function$;'.length);
}

const WH = '11111111-1111-1111-1111-111111111111';
const ITEM = 'SKU-D15';
let admin: Sql;

async function resetFixture(sql: Sql, fifo: 'old' | 'new'): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') throw new Error('PG tests refuse a non-local TEST_DATABASE_URL');
  if (parsed.pathname !== '/houzs_test') throw new Error('PG tests require the disposable houzs_test database');
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS scm;
    DROP TABLE IF EXISTS scm.inventory_lot_consumptions CASCADE;
    DROP TABLE IF EXISTS scm.inventory_lots CASCADE;
    DROP TABLE IF EXISTS scm.inventory_movements CASCADE;
    CREATE TABLE scm.inventory_movements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id bigint DEFAULT 1,
      movement_type text NOT NULL, warehouse_id uuid NOT NULL, item_code text NOT NULL, variant_key text NOT NULL DEFAULT '',
      product_name text, qty integer NOT NULL, unit_cost_sen integer, total_cost_sen integer, batch_no text,
      source_doc_type text, source_doc_id uuid, source_doc_no text, performed_by uuid,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE scm.inventory_lots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id bigint,
      warehouse_id uuid, item_code text, variant_key text, product_name text,
      qty_received integer, qty_remaining integer, unit_cost_sen integer, received_at timestamptz,
      source_doc_type text, source_doc_id uuid, source_doc_no text, movement_id uuid, created_by uuid, batch_no text
    );
    CREATE TABLE scm.inventory_lot_consumptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lot_id uuid, warehouse_id uuid, item_code text, variant_key text,
      qty_consumed integer, unit_cost_sen integer, total_cost_sen integer,
      source_doc_type text, source_doc_id uuid, source_doc_no text, movement_id uuid, created_by uuid
    );
  `);
  const live = await fileEndingWith('0307_item_code_unify.sql');
  await sql.unsafe(functionBlock(live, 'fn_consume_fifo'));
  await sql.unsafe(functionBlock(live, 'fn_consume_fifo_batch'));
  if (fifo === 'old') {
    await sql.unsafe('ALTER TABLE scm.inventory_movements ADD COLUMN reverses_movement_id uuid');
    await sql.unsafe(functionBlock(live, 'fn_inventory_movement_fifo'));
  } else {
    await sql.unsafe(await fileEndingWith('_scm_reversed_short_out_lot_qty.sql'));
  }
  await sql.unsafe(`CREATE TRIGGER trg_inventory_movement_fifo AFTER INSERT ON scm.inventory_movements
    FOR EACH ROW EXECUTE FUNCTION scm.fn_inventory_movement_fifo()`);
}

async function move(sql: Sql, v: { type: 'IN' | 'OUT'; qty: number; doc: string; docType: string; cost: number | null; reverses: string | null }): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO scm.inventory_movements (movement_type, warehouse_id, item_code, qty, unit_cost_sen, source_doc_type, source_doc_id, reverses_movement_id)
    VALUES (${v.type}, ${WH}, ${ITEM}, ${v.qty}, ${v.cost}, ${v.docType}, ${v.doc}, ${v.reverses}) RETURNING id::text AS id`;
  return row!.id;
}

async function state(sql: Sql): Promise<{ balance: number; lots: number }> {
  const [b] = await sql<{ q: number }[]>`SELECT coalesce(sum(CASE WHEN movement_type = 'OUT' THEN -qty ELSE qty END), 0)::int AS q FROM scm.inventory_movements`;
  const [l] = await sql<{ q: number }[]>`SELECT coalesce(sum(qty_remaining), 0)::int AS q FROM scm.inventory_lots`;
  return { balance: b!.q, lots: l!.q };
}

const PR = '22222222-2222-2222-2222-222222222222';
const GRN = '33333333-3333-3333-3333-333333333333';

/** 2 in stock at RM 10, a purchase return of 5 (3 short), then its cancel puts 5 back. */
async function shortReturnCancelled(sql: Sql): Promise<string> {
  await move(sql, { type: 'IN', qty: 2, cost: 1000, docType: 'GRN', doc: GRN, reverses: null });
  const out = await move(sql, { type: 'OUT', qty: 5, cost: null, docType: 'PURCHASE_RETURN', doc: PR, reverses: null });
  expect(await state(sql)).toEqual({ balance: -3, lots: 0 });
  return move(sql, { type: 'IN', qty: 5, cost: 400, docType: 'PURCHASE_RETURN', doc: PR, reverses: out });
}

describePg('a reversed short stock-out puts back only what it took', () => {
  beforeAll(() => { admin = postgres(url, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await admin?.end(); });

  describe('the live (0307) trigger', () => {
    beforeEach(async () => { await resetFixture(admin, 'old'); });
    test('re-opens the full qty: lots end above the balance (the defect)', async () => {
      await shortReturnCancelled(admin);
      expect(await state(admin)).toEqual({ balance: 2, lots: 5 });
    });
  });

  describe('with 20261123T0100', () => {
    beforeEach(async () => { await resetFixture(admin, 'new'); });

    test('a purchase return of 5 with 2 in stock, cancelled: 2 go back at RM 10, lots equal the balance', async () => {
      const inId = await shortReturnCancelled(admin);
      expect(await state(admin)).toEqual({ balance: 2, lots: 2 });
      const [lot] = await admin<{ qty_received: number; unit_cost_sen: number }[]>`SELECT qty_received, unit_cost_sen FROM scm.inventory_lots WHERE movement_id = ${inId}`;
      expect(lot).toEqual({ qty_received: 2, unit_cost_sen: 1000 });
      const [mv] = await admin<{ qty: number; unit_cost_sen: number; total_cost_sen: number }[]>`SELECT qty, unit_cost_sen, total_cost_sen FROM scm.inventory_movements WHERE id = ${inId}`;
      expect(mv).toEqual({ qty: 5, unit_cost_sen: 1000, total_cost_sen: 2000 });
    });

    test('a stock-out that took nothing opens no lot when reversed', async () => {
      const doc = '44444444-4444-4444-4444-444444444444';
      const out = await move(admin, { type: 'OUT', qty: 3, cost: null, docType: 'STOCK_TRANSFER', doc, reverses: null });
      const inId = await move(admin, { type: 'IN', qty: 3, cost: 0, docType: 'STOCK_TRANSFER', doc, reverses: out });
      const [n] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM scm.inventory_lots WHERE movement_id = ${inId}`;
      expect(n!.n).toBe(0);
      expect(await state(admin)).toEqual({ balance: 0, lots: 0 });
    });

    test('a full stock-out reversed puts all of it back', async () => {
      await move(admin, { type: 'IN', qty: 4, cost: 700, docType: 'GRN', doc: GRN, reverses: null });
      const out = await move(admin, { type: 'OUT', qty: 4, cost: null, docType: 'PURCHASE_RETURN', doc: PR, reverses: null });
      await move(admin, { type: 'IN', qty: 4, cost: 700, docType: 'PURCHASE_RETURN', doc: PR, reverses: out });
      expect(await state(admin)).toEqual({ balance: 4, lots: 4 });
    });

    test('an ordinary IN, and an IN naming a DO, still open a lot for the whole qty', async () => {
      const inId = await move(admin, { type: 'IN', qty: 4, cost: 700, docType: 'GRN', doc: GRN, reverses: null });
      const doOut = await move(admin, { type: 'OUT', qty: 6, cost: null, docType: 'DO', doc: PR, reverses: null });
      const doBack = await move(admin, { type: 'IN', qty: 6, cost: 700, docType: 'DO', doc: PR, reverses: doOut });
      const lots = await admin<{ movement_id: string; qty_received: number }[]>`SELECT movement_id::text AS movement_id, qty_received FROM scm.inventory_lots ORDER BY received_at`;
      expect(lots).toEqual([{ movement_id: inId, qty_received: 4 }, { movement_id: doBack, qty_received: 6 }]);
    });
  });
});
