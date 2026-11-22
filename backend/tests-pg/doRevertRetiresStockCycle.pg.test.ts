import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

/* Symptom: a delivery order reverted to Draft and shipped again took no stock out; stock read too high.
 * Cause: the revert's reversal rows ('ADJUSTMENT' + DO id) left the first OUT tagged 'DO', so the re-ship's
 *   guard no-oped and uq_inv_mov_do_source_v2 would have refused a second first-ship row anyway.
 * Fix: scm.fn_retire_do_stock_cycle re-tags the returned cycle 'DO_REVERTED'; refused while stock is out.
 *
 * Runs against CI's postgres:16 (`backend-postgres` -> `npm run test:pg`); skipped without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

async function migrationSql(): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_scm_do_revert_retires_stock_cycle.sql'));
  if (files.length !== 1) throw new Error(`expected one *_scm_do_revert_retires_stock_cycle.sql, found ${files.length}`);
  return readFile(join(migrationsDir, files[0]!), 'utf8');
}

const WH = '11111111-1111-1111-1111-111111111111';
const DO_ID = '33333333-3333-3333-3333-333333333333';
const CODE = 'TRION-(K)';

let admin: Sql;

async function resetFixture(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') throw new Error('PG tests refuse a non-local TEST_DATABASE_URL');
  if (parsed.pathname !== '/houzs_test') throw new Error('PG tests require the disposable houzs_test database');
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS scm;
    DROP TABLE IF EXISTS scm.inventory_lot_consumptions CASCADE;
    DROP TABLE IF EXISTS scm.inventory_movements CASCADE;
    DROP TABLE IF EXISTS scm.delivery_orders CASCADE;
    CREATE TABLE scm.delivery_orders (id uuid PRIMARY KEY, do_number text NOT NULL);
    CREATE TABLE scm.inventory_movements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      movement_type text, warehouse_id uuid, item_code text, variant_key text DEFAULT '' NOT NULL,
      qty integer, source_doc_type text, source_doc_id uuid, source_doc_no text, correction_seq smallint,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX uq_inv_mov_do_source_v2 ON scm.inventory_movements
      USING btree (source_doc_type, source_doc_id, item_code, variant_key, COALESCE(correction_seq, 0))
      WHERE (source_doc_type = 'DO'::text);
    CREATE TABLE scm.inventory_lot_consumptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), movement_id uuid, lot_id uuid,
      qty_consumed integer, source_doc_type text, source_doc_id uuid
    );
  `);
  await sql`INSERT INTO scm.delivery_orders (id, do_number) VALUES (${DO_ID}, 'DO-1')`;
}

async function applyMigration(sql: Sql): Promise<void> {
  await sql.unsafe(await migrationSql());
  await sql.unsafe(`
    DROP TRIGGER IF EXISTS trg_do_header_delete_lock ON scm.delivery_orders;
    CREATE TRIGGER trg_do_header_delete_lock BEFORE DELETE ON scm.delivery_orders
      FOR EACH ROW EXECUTE FUNCTION scm.fn_do_header_delete_lock();
  `);
}

async function ship(sql: Sql, qty = 5): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO scm.inventory_movements (movement_type, warehouse_id, item_code, qty, source_doc_type, source_doc_id, source_doc_no)
    VALUES ('OUT', ${WH}, ${CODE}, ${qty}, 'DO', ${DO_ID}, 'DO-1') RETURNING id`;
  return row!.id;
}

async function reverse(sql: Sql, qty = 5): Promise<void> {
  await sql`
    INSERT INTO scm.inventory_movements (movement_type, warehouse_id, item_code, qty, source_doc_type, source_doc_id, source_doc_no)
    VALUES ('ADJUSTMENT', ${WH}, ${CODE}, ${qty}, 'ADJUSTMENT', ${DO_ID}, 'DO-1')`;
}

const tags = async (sql: Sql) =>
  (await sql<{ source_doc_type: string; n: number }[]>`
    SELECT source_doc_type, count(*)::int AS n FROM scm.inventory_movements GROUP BY 1 ORDER BY 1`)
    .map((r) => `${r.source_doc_type}:${r.n}`);

describePg('fn_retire_do_stock_cycle — a reverted DO can ship again', () => {
  beforeAll(() => { admin = postgres(url, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await admin?.end(); });
  beforeEach(async () => { await resetFixture(admin); await applyMigration(admin); });

  test('without the retire, a second ship of the same DO is refused by the index (the defect)', async () => {
    await ship(admin);
    await reverse(admin);
    await expect(ship(admin)).rejects.toThrow(/uq_inv_mov_do_source_v2/);
  });

  test('retire re-tags the returned cycle, then the re-ship lands and a second cycle retires too', async () => {
    const out = await ship(admin);
    await admin`INSERT INTO scm.inventory_lot_consumptions (movement_id, qty_consumed, source_doc_type, source_doc_id) VALUES (${out}, 5, 'DO', ${DO_ID})`;
    await reverse(admin);
    const [{ n }] = await admin<{ n: number }[]>`SELECT scm.fn_retire_do_stock_cycle(${DO_ID}) AS n`;
    expect(n).toBe(2);
    expect(await tags(admin)).toEqual(['DO_REVERTED:2']);
    const [con] = await admin<{ source_doc_type: string }[]>`SELECT source_doc_type FROM scm.inventory_lot_consumptions`;
    expect(con!.source_doc_type).toBe('DO_REVERTED');

    await ship(admin, 3);
    expect(await tags(admin)).toEqual(['DO:1', 'DO_REVERTED:2']);
    await reverse(admin, 3);
    await admin`SELECT scm.fn_retire_do_stock_cycle(${DO_ID})`;
    expect(await tags(admin)).toEqual(['DO_REVERTED:4']);
  });

  test('refused while stock is still out (no reversal, or a short one)', async () => {
    await ship(admin);
    await expect(admin`SELECT scm.fn_retire_do_stock_cycle(${DO_ID})`).rejects.toThrow(/still has 5 unit/);
    await reverse(admin, 2);
    await expect(admin`SELECT scm.fn_retire_do_stock_cycle(${DO_ID})`).rejects.toThrow(/still has 3 unit/);
    expect(await tags(admin)).toEqual(['ADJUSTMENT:1', 'DO:1']);
  });

  test('a never-shipped DO retires nothing', async () => {
    const [{ n }] = await admin<{ n: number }[]>`SELECT scm.fn_retire_do_stock_cycle(${DO_ID}) AS n`;
    expect(n).toBe(0);
  });

  test('the header delete lock still sees a retired ship', async () => {
    await ship(admin);
    await reverse(admin);
    await admin`SELECT scm.fn_retire_do_stock_cycle(${DO_ID})`;
    await expect(admin`DELETE FROM scm.delivery_orders WHERE id = ${DO_ID}`).rejects.toThrow(/do_header_integrity/);
  });
});
