import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { bookMovements } from '../src/routes/lib/pos-ingest';
import { movementsFor, voidMovementsFor, type IncomingSale } from '../src/routes/lib/pos-sync';
import { nameTheShipOutsReturned } from '../src/scm/lib/consignment-return-reversal';
import { fakeSb } from '../src/scm/lib/fake-postgrest';

/* Symptom: a POS sale, or a Consignment Note ship-out, that found no stock took nothing from the FIFO lots; voiding
 *   the sale, or returning the goods, then opened a full lot, so lots stood above the stock balance (production,
 *   23 Nov 2026: T01-000001..4 at C&C DISPLAY, HC-CN-2610-001 / HC-CRN-2610-001 at KL).
 * Cause: neither IN named the OUT it undoes, so the FIFO trigger (20261123T0100) opened a lot for its full qty.
 * Fix: the void's IN and the return's IN carry reverses_movement_id; the trigger re-opens only what the OUT took.
 *
 * Real postgres:16 with the live FIFO functions (0307 + 20261123T0100). The POS half runs bookMovements itself in
 * a drizzle transaction; the return half runs the naming helper on the real rows and inserts what it produced. */

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

const WH = '11111111-1111-1111-1111-111111111111';
const GRN = '33333333-3333-3333-3333-333333333333';
const NOTE = '66666666-6666-6666-6666-666666666666';
const RET = '77777777-7777-7777-7777-777777777777';
let admin: Sql;

async function resetFixture(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') throw new Error('PG tests refuse a non-local TEST_DATABASE_URL');
  if (parsed.pathname !== '/houzs_test') throw new Error('PG tests require the disposable houzs_test database');
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS scm;
    DROP VIEW IF EXISTS scm.inventory_balances;
    DROP TABLE IF EXISTS scm.inventory_lot_consumptions CASCADE;
    DROP TABLE IF EXISTS scm.inventory_lots CASCADE;
    DROP TABLE IF EXISTS scm.inventory_movements CASCADE;
    DROP TYPE IF EXISTS scm.inventory_movement_type CASCADE;
    CREATE TYPE scm.inventory_movement_type AS ENUM ('IN', 'OUT', 'ADJUSTMENT', 'TRANSFER');
    CREATE TABLE scm.inventory_movements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id bigint DEFAULT 1,
      movement_type scm.inventory_movement_type NOT NULL, warehouse_id uuid NOT NULL, item_code text NOT NULL, variant_key text NOT NULL DEFAULT '',
      product_name text, qty integer NOT NULL, unit_cost_sen integer, total_cost_sen integer, batch_no text,
      source_doc_type text, source_doc_id uuid, source_doc_no text, performed_by uuid, notes text, movement_date date, reason_code text,
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
  await sql.unsafe(`CREATE VIEW scm.inventory_balances AS
    SELECT company_id, warehouse_id, item_code, variant_key,
           sum(CASE movement_type WHEN 'OUT' THEN -qty ELSE qty END) AS qty
      FROM scm.inventory_movements GROUP BY 1, 2, 3, 4`);
}

async function state(sql: Sql, item: string): Promise<{ balance: number; lots: number }> {
  const [b] = await sql<{ q: number }[]>`SELECT coalesce(sum(CASE WHEN movement_type = 'OUT' THEN -qty ELSE qty END), 0)::int AS q
    FROM scm.inventory_movements WHERE item_code = ${item}`;
  const [l] = await sql<{ q: number }[]>`SELECT coalesce(sum(qty_remaining), 0)::int AS q FROM scm.inventory_lots WHERE item_code = ${item}`;
  return { balance: b!.q, lots: l!.q };
}

async function grnIn(sql: Sql, item: string, qty: number): Promise<void> {
  await sql`INSERT INTO scm.inventory_movements (movement_type, warehouse_id, item_code, qty, unit_cost_sen, source_doc_type, source_doc_id)
            VALUES ('IN', ${WH}, ${item}, ${qty}, 1000, 'GRN', ${GRN})`;
}

const sale = (receipt: string, code: string, qty: number) => ({
  receipt_no: receipt, type: 'SALE', status: 'PAID',
  lines: [{ line_no: 1, code, description: code, qty }],
}) as unknown as IncomingSale;

describePg('a void or a return puts back only what its stock-out took', () => {
  beforeAll(() => { admin = postgres(url, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await admin?.end(); });
  beforeEach(async () => { await resetFixture(admin); });

  const book = async (rows: ReturnType<typeof movementsFor>) => {
    const db = drizzle(admin);
    await db.transaction(async (tx) => { await bookMovements(tx as never, 1, WH, rows, 'cashier'); });
  };

  test('POS: a sale of 1 with nothing on the shelf, voided: no lot is opened', async () => {
    const s = sale('T01-000001', 'ARO-1', 1);
    await book(movementsFor(s));
    expect(await state(admin, 'ARO-1')).toEqual({ balance: -1, lots: 0 });
    await book(voidMovementsFor(s));
    expect(await state(admin, 'ARO-1')).toEqual({ balance: 0, lots: 0 });
  });

  test('POS: a sale of 1 from a shelf of 2, voided: the unit goes back, lots equal the balance', async () => {
    await grnIn(admin, 'ARO-2', 2);
    const s = sale('T01-000002', 'ARO-2', 1);
    await book(movementsFor(s));
    await book(voidMovementsFor(s));
    expect(await state(admin, 'ARO-2')).toEqual({ balance: 2, lots: 2 });
  });

  test('Consignment: a ship-out of 1 that took nothing, returned: no lot is opened', async () => {
    await admin`INSERT INTO scm.inventory_movements (movement_type, warehouse_id, item_code, qty, source_doc_type, source_doc_id, source_doc_no)
                VALUES ('OUT', ${WH}, 'DIVAN-K', 1, 'CS_DO', ${NOTE}, 'HC-CN-1')`;
    const rows = await admin<Record<string, unknown>[]>`SELECT id::text AS id, movement_type::text AS movement_type, item_code, variant_key,
      source_doc_type, source_doc_id::text AS source_doc_id FROM scm.inventory_movements`;
    const sb = fakeSb({ inventory_movements: rows.map((r) => ({ ...r })) });
    const writes: Array<{ movement_type: string; item_code: string; variant_key?: string; reverses_movement_id?: string }> =
      [{ movement_type: 'IN', item_code: 'DIVAN-K', variant_key: '' }];
    await nameTheShipOutsReturned(sb as never, writes, NOTE);
    await admin`INSERT INTO scm.inventory_movements (movement_type, warehouse_id, item_code, qty, unit_cost_sen, source_doc_type, source_doc_id, source_doc_no, reverses_movement_id)
                VALUES ('IN', ${WH}, 'DIVAN-K', 1, 5000, 'CS_DR', ${RET}, 'HC-CRN-1', ${writes[0]!.reverses_movement_id ?? null})`;
    expect(await state(admin, 'DIVAN-K')).toEqual({ balance: 0, lots: 0 });
  });
});
