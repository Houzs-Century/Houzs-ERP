import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

/*
 * 20261127T1200_scm_stock_transfer_racks — owner 2026-11-27: a transfer line may name a
 * From rack and a To rack, and the stock move plus both rack moves land in ONE transaction.
 * fn_stock_transfer_apply is stubbed here (it writes one marker row per line) so the test
 * can see whether the stock side rolled back with the racks.
 */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

async function migrationSql(): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_scm_stock_transfer_racks.sql'));
  if (files.length !== 1) throw new Error(`expected one *_scm_stock_transfer_racks.sql, found ${files.length}`);
  return readFile(join(migrationsDir, files[0]!), 'utf8');
}

const KL = '11111111-1111-1111-1111-111111111111';
const PJ = '22222222-2222-2222-2222-222222222222';
const R_KL = 'aaaaaaaa-0000-4000-8000-000000000001';
const R_KL2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const R_PJ = 'bbbbbbbb-0000-4000-8000-000000000001';
const XFER = '33333333-3333-3333-3333-333333333333';
const CODE = 'MAT-FIRM-K';

let admin: Sql;

async function resetFixture(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') throw new Error('PG tests refuse a non-local TEST_DATABASE_URL');
  if (parsed.pathname !== '/houzs_test') throw new Error('PG tests require the disposable houzs_test database');
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS scm;
    DROP TABLE IF EXISTS scm.stock_move_marks, scm.stock_transfer_lines, scm.stock_transfers,
      scm.warehouse_rack_movements, scm.warehouse_rack_items, scm.warehouse_racks CASCADE;
    CREATE TABLE scm.warehouse_racks (
      id uuid PRIMARY KEY, warehouse_id uuid NOT NULL, rack text NOT NULL,
      status text NOT NULL DEFAULT 'EMPTY', reserved boolean NOT NULL DEFAULT false, company_id bigint NOT NULL
    );
    CREATE TABLE scm.warehouse_rack_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rack_id uuid NOT NULL REFERENCES scm.warehouse_racks(id),
      item_code text NOT NULL, variant_key text NOT NULL DEFAULT '', product_name text, source_doc_no text,
      qty integer NOT NULL CHECK (qty > 0), stocked_in_date date NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(), company_id bigint NOT NULL
    );
    CREATE TABLE scm.warehouse_rack_movements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), movement_type text NOT NULL, rack_id uuid, rack_label text,
      to_rack_id uuid, to_rack_label text, warehouse_id uuid, item_code text, variant_key text NOT NULL DEFAULT '',
      product_name text, source_doc_no text, quantity integer NOT NULL, reason text, performed_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(), company_id bigint NOT NULL
    );
    CREATE TABLE scm.stock_transfers (
      id uuid PRIMARY KEY, transfer_no text NOT NULL, from_warehouse_id uuid, to_warehouse_id uuid, company_id bigint
    );
    CREATE TABLE scm.stock_transfer_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), stock_transfer_id uuid, item_code text, product_name text,
      variant_key text, qty integer
    );
    CREATE TABLE scm.stock_move_marks (id serial PRIMARY KEY, item_code text, qty integer);
    CREATE OR REPLACE FUNCTION scm.fn_stock_transfer_apply(
      p_from uuid, p_to uuid, p_doc uuid, p_no text, p_co bigint, p_by uuid, p_lines jsonb)
     RETURNS integer LANGUAGE plpgsql AS $$
    DECLARE v jsonb; n integer := 0;
    BEGIN
      FOR v IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
        INSERT INTO scm.stock_move_marks (item_code, qty) VALUES (v->>'item_code', (v->>'qty')::int);
        n := n + 1;
      END LOOP;
      RETURN n;
    END $$;
  `);
  await sql.unsafe(`
    INSERT INTO scm.warehouse_racks (id, warehouse_id, rack, company_id) VALUES
      ('${R_KL}', '${KL}', 'L5.2', 1), ('${R_KL2}', '${KL}', 'R3.1', 1), ('${R_PJ}', '${PJ}', 'CA4', 1);
    INSERT INTO scm.warehouse_rack_items (rack_id, item_code, qty, stocked_in_date, company_id) VALUES
      ('${R_KL}', '${CODE}', 2, '2026-11-01', 1), ('${R_KL}', '${CODE}', 2, '2026-11-02', 1);
    INSERT INTO scm.stock_transfers (id, transfer_no, from_warehouse_id, to_warehouse_id, company_id)
      VALUES ('${XFER}', 'HC-ST-TEST', '${KL}', '${PJ}', 1);
  `);
  await sql.unsafe(await migrationSql());
}

const line = (qty: number, from: string | null, to: string | null) => ({
  item_code: CODE, product_name: 'Firm King', variant_key: '', qty, batch_no: null,
  ...(from ? { from_rack_id: from } : {}), ...(to ? { to_rack_id: to } : {}),
});

async function apply(sql: Sql, lines: unknown[]): Promise<void> {
  await sql`SELECT scm.fn_stock_transfer_apply_racked(${KL}::uuid, ${PJ}::uuid, ${XFER}::uuid, 'HC-ST-TEST', 1, NULL, ${sql.json(lines as postgres.JSONValue)})`;
  for (const l of lines as Array<{ qty: number; from_rack_id?: string; to_rack_id?: string }>) {
    await sql`INSERT INTO scm.stock_transfer_lines (stock_transfer_id, item_code, variant_key, qty, from_rack_id, to_rack_id)
      VALUES (${XFER}, ${CODE}, '', ${l.qty}, ${l.from_rack_id ?? null}, ${l.to_rack_id ?? null})`;
  }
}

const onRack = async (sql: Sql, rack: string): Promise<number> =>
  Number((await sql`SELECT COALESCE(SUM(qty), 0) AS q FROM scm.warehouse_rack_items WHERE rack_id = ${rack}`)[0]!.q);
const marks = async (sql: Sql): Promise<number> => Number((await sql`SELECT count(*) AS n FROM scm.stock_move_marks`)[0]!.n);
const status = async (sql: Sql, rack: string): Promise<string> =>
  String((await sql`SELECT status FROM scm.warehouse_racks WHERE id = ${rack}`)[0]!.status);

describePg('stock transfer racks move with the stock, in one transaction', () => {
  beforeAll(() => { admin = postgres(url, { max: 1, onnotice: () => undefined }); });
  afterAll(async () => { await admin?.end(); });
  beforeEach(async () => { await resetFixture(admin); });

  test('From and To racks: oldest placement taken first, goods placed on the To rack, history written', async () => {
    await apply(admin, [line(3, R_KL, R_PJ)]);
    expect(await marks(admin)).toBe(1);
    expect(await onRack(admin, R_KL)).toBe(1);
    expect(await onRack(admin, R_PJ)).toBe(3);
    const left = await admin`SELECT stocked_in_date::text AS d, qty FROM scm.warehouse_rack_items WHERE rack_id = ${R_KL}`;
    expect(left).toEqual([{ d: '2026-11-02', qty: 1 }]);
    const hist = await admin`SELECT movement_type, rack_label, quantity FROM scm.warehouse_rack_movements ORDER BY movement_type`;
    expect(hist).toEqual([
      { movement_type: 'STOCK_IN', rack_label: 'CA4', quantity: 3 },
      { movement_type: 'STOCK_OUT', rack_label: 'L5.2', quantity: 3 },
    ]);
    expect(await status(admin, R_PJ)).toBe('OCCUPIED');
    const head = await admin`SELECT racks_applied_at IS NOT NULL AS applied FROM scm.stock_transfers WHERE id = ${XFER}`;
    expect(head[0]!.applied).toBe(true);
  });

  test('a From rack that holds too little refuses the whole call: no stock move, no rack change', async () => {
    await expect(apply(admin, [line(5, R_KL, R_PJ)])).rejects.toThrow(/rack_short/);
    expect(await marks(admin)).toBe(0);
    expect(await onRack(admin, R_KL)).toBe(4);
    expect(await onRack(admin, R_PJ)).toBe(0);
    expect(Number((await admin`SELECT count(*) AS n FROM scm.warehouse_rack_movements`)[0]!.n)).toBe(0);
  });

  test('a rack of the wrong warehouse refuses the whole call', async () => {
    await expect(apply(admin, [line(1, R_KL, R_KL2)])).rejects.toThrow(/rack_not_in_warehouse/);
    expect(await marks(admin)).toBe(0);
    expect(await onRack(admin, R_KL)).toBe(4);
  });

  test('a line with no rack moves stock only; the transfer is not marked as rack-moved', async () => {
    await apply(admin, [line(2, null, null)]);
    expect(await marks(admin)).toBe(1);
    expect(await onRack(admin, R_KL)).toBe(4);
    const head = await admin`SELECT racks_applied_at FROM scm.stock_transfers WHERE id = ${XFER}`;
    expect(head[0]!.racks_applied_at).toBeNull();
  });

  test('cancel puts the racks back once; a second undo does nothing', async () => {
    await apply(admin, [line(3, R_KL, R_PJ)]);
    const first = await admin`SELECT scm.fn_stock_transfer_racks_undo(${XFER}::uuid, 1, NULL) AS n`;
    expect(first[0]!.n).toBe(1);
    expect(await onRack(admin, R_KL)).toBe(4);
    expect(await onRack(admin, R_PJ)).toBe(0);
    expect(await status(admin, R_PJ)).toBe('EMPTY');
    const again = await admin`SELECT scm.fn_stock_transfer_racks_undo(${XFER}::uuid, 1, NULL) AS n`;
    expect(again[0]!.n).toBe(0);
    expect(await onRack(admin, R_KL)).toBe(4);
  });

  test('undo of a transfer whose racks never moved changes nothing', async () => {
    const n = await admin`SELECT scm.fn_stock_transfer_racks_undo(${XFER}::uuid, 1, NULL) AS n`;
    expect(n[0]!.n).toBe(0);
    expect(await onRack(admin, R_KL)).toBe(4);
  });

  test('undo of another company refuses to touch the transfer', async () => {
    await apply(admin, [line(3, R_KL, R_PJ)]);
    const n = await admin`SELECT scm.fn_stock_transfer_racks_undo(${XFER}::uuid, 2, NULL) AS n`;
    expect(n[0]!.n).toBe(0);
    expect(await onRack(admin, R_PJ)).toBe(3);
  });
});
