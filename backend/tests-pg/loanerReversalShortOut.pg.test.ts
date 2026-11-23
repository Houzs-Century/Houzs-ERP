import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/scm/lib/oversell-retrocost', () => ({
  reconcileUncostedAfterIn: async () => ({ reconciled: 0, affectedDoIds: [] }),
}));
vi.mock('../src/scm/lib/stock-allocation-job', () => ({ recomputeAllocationAfterSave: async () => {} }));

import { fakeSb } from '../src/scm/lib/fake-postgrest';
import { reverseLoaner } from '../src/scm/lib/consignment-loaner';

/* Symptom: cancelling a consignment loaner whose stock-out was short put the FULL qty back into the source
 *   warehouse's FIFO lots, so they stood above its stock balance by the short.
 * Cause: reverseLoaner merged the doc's OUTs into one reversing IN that named no OUT, so the FIFO trigger
 *   (20261123T0100) could not tell what the OUT had taken.
 * Fix: one reversing IN per original OUT, stamped with reverses_movement_id.
 *
 * reverseLoaner runs against the fake PostgREST loaded with the real rows; every movement it writes is then
 * inserted, in order, into postgres:16 carrying the live FIFO functions (0307 + 20261123T0100), and the lots are
 * read back. Skipped without TEST_DATABASE_URL (CI's `backend-postgres` job sets it). */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

async function fileEndingWith(suffix: string): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(suffix));
  if (files.length !== 1) throw new Error(`expected one *${suffix}, found ${files.length}`);
  return readFile(join(migrationsDir, files[0]!), 'utf8');
}

function functionBlock(sqlText: string, name: string): string {
  const start = sqlText.indexOf(`CREATE OR REPLACE FUNCTION scm.${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const open = sqlText.indexOf('$function$', start);
  const close = sqlText.indexOf('$function$;', open + 10);
  return sqlText.slice(start, close + '$function$;'.length);
}

const SRC = '11111111-1111-1111-1111-111111111111';
const CONS = '55555555-5555-5555-5555-555555555555';
const GRN = '33333333-3333-3333-3333-333333333333';
const CS = '66666666-6666-6666-6666-666666666666';
const COLS = [
  'company_id', 'movement_type', 'warehouse_id', 'item_code', 'variant_key', 'product_name', 'qty', 'unit_cost_sen',
  'batch_no', 'source_doc_type', 'source_doc_id', 'source_doc_no', 'performed_by', 'notes', 'movement_date',
  'reverses_movement_id',
] as const;
let admin: Sql;

async function resetFixture(sql: Sql): Promise<void> {
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
      source_doc_type text, source_doc_id uuid, source_doc_no text, performed_by uuid, notes text, movement_date date,
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
  await sql.unsafe(await fileEndingWith('_scm_reversed_short_out_lot_qty.sql'));
  await sql.unsafe(`CREATE TRIGGER trg_inventory_movement_fifo AFTER INSERT ON scm.inventory_movements
    FOR EACH ROW EXECUTE FUNCTION scm.fn_inventory_movement_fifo()`);
}

async function insert(sql: Sql, row: Record<string, unknown>): Promise<void> {
  const cols = COLS.filter((c) => row[c] !== undefined);
  await sql.unsafe(
    `INSERT INTO scm.inventory_movements (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => row[c]) as never[],
  );
}

async function at(sql: Sql, wh: string): Promise<{ balance: number; lots: number }> {
  const [b] = await sql<{ q: number }[]>`SELECT coalesce(sum(CASE WHEN movement_type = 'OUT' THEN -qty ELSE qty END), 0)::int AS q
    FROM scm.inventory_movements WHERE warehouse_id = ${wh}`;
  const [l] = await sql<{ q: number }[]>`SELECT coalesce(sum(qty_remaining), 0)::int AS q FROM scm.inventory_lots WHERE warehouse_id = ${wh}`;
  return { balance: b!.q, lots: l!.q };
}

/** Run reverseLoaner on the real rows, then write what it wrote into Postgres, in order. */
async function cancelLoaner(sql: Sql): Promise<string[]> {
  const before = await sql<Record<string, unknown>[]>`SELECT id::text AS id, movement_type, warehouse_id::text AS warehouse_id,
    item_code, variant_key, product_name, qty, total_cost_sen, batch_no, source_doc_type, source_doc_id::text AS source_doc_id,
    source_doc_no, company_id::int AS company_id FROM scm.inventory_movements ORDER BY created_at`;
  const sb = fakeSb({ inventory_movements: before.map((r) => ({ ...r })) });
  const errors = await reverseLoaner(sb as never, 'CS_DO', CS, 'CS-1', SRC, CONS, null, 1);
  for (const row of (sb.tables.inventory_movements as Record<string, unknown>[]).slice(before.length)) await insert(sql, row);
  return errors;
}

describePg('cancelling a consignment loaner puts back only what its stock-out took', () => {
  beforeAll(() => { admin = postgres(url, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await admin?.end(); });
  beforeEach(async () => { await resetFixture(admin); });

  test('2 on the shelf, a loaner of 5 (3 short), cancelled: the shelf is back to 2 with 2 in lots', async () => {
    await insert(admin, { movement_type: 'IN', warehouse_id: SRC, item_code: 'SKU-L', qty: 2, unit_cost_sen: 1000, source_doc_type: 'GRN', source_doc_id: GRN });
    await insert(admin, { movement_type: 'OUT', warehouse_id: SRC, item_code: 'SKU-L', qty: 5, source_doc_type: 'CS_DO', source_doc_id: CS, source_doc_no: 'CS-1' });
    await insert(admin, { movement_type: 'IN', warehouse_id: CONS, item_code: 'SKU-L', qty: 5, unit_cost_sen: 400, source_doc_type: 'STOCK_TRANSFER', source_doc_id: CS, source_doc_no: 'CS-1' });
    expect(await at(admin, SRC)).toEqual({ balance: -3, lots: 0 });

    expect(await cancelLoaner(admin)).toEqual([]);

    expect(await at(admin, SRC)).toEqual({ balance: 2, lots: 2 });
    expect(await at(admin, CONS)).toEqual({ balance: 0, lots: 0 });
    const [lot] = await admin<{ qty_received: number; unit_cost_sen: number }[]>`SELECT qty_received, unit_cost_sen
      FROM scm.inventory_lots WHERE warehouse_id = ${SRC} AND source_doc_no = 'CS-1-CANCEL'`;
    expect(lot).toEqual({ qty_received: 2, unit_cost_sen: 1000 });
  });

  test('a loaner of two products, each short, cancelled: lots equal the balance for both', async () => {
    for (const [item, onShelf, lent] of [['SKU-A', 1, 4], ['SKU-B', 3, 5]] as const) {
      await insert(admin, { movement_type: 'IN', warehouse_id: SRC, item_code: item, qty: onShelf, unit_cost_sen: 500, source_doc_type: 'GRN', source_doc_id: GRN });
      await insert(admin, { movement_type: 'OUT', warehouse_id: SRC, item_code: item, qty: lent, source_doc_type: 'CS_DO', source_doc_id: CS, source_doc_no: 'CS-1' });
      await insert(admin, { movement_type: 'IN', warehouse_id: CONS, item_code: item, qty: lent, unit_cost_sen: 0, source_doc_type: 'STOCK_TRANSFER', source_doc_id: CS, source_doc_no: 'CS-1' });
    }
    expect(await cancelLoaner(admin)).toEqual([]);
    expect(await at(admin, SRC)).toEqual({ balance: 4, lots: 4 });
  });
});
