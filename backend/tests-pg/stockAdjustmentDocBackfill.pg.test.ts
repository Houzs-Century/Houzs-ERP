import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';
import { applyDocNoCounterMigration, assertDisposableTestDatabase } from './lib/doc-no-fixture';

/* BUG-66 (2026-10-07): every manual stock adjustment written before it became a
 * document gets one — one header + one line per old movement, numbered
 * `<prefix>SA-YYMM-NNN` by created_at in MALAYSIA time. It runs once, on deploy,
 * so it is proven here on real Postgres, replaying the two real migration files
 * the way pg-migrate.mjs does (split, one transaction each). Located by SUFFIX,
 * never by number. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

async function applyBySuffix(sql: Sql, suffix: string): Promise<void> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(suffix));
  if (files.length !== 1) throw new Error(`expected exactly one *${suffix}, found ${files.length}: ${files.join(', ')}`);
  const stmts = splitSqlStatements(await readFile(join(migrationsDir, files[0]!), 'utf8')) as string[];
  await sql.begin(async (tx) => { for (const s of stmts) await tx.unsafe(s); });
}

const WH = '00000000-0000-4000-8000-0000000000a1';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DO_ID = '00000000-0000-4000-8000-0000000000d0';
const TAKE_ID = '00000000-0000-4000-8000-0000000000e0';

let sql: Sql;

const headers = () => sql<{ id: string; adjustment_no: string; company_id: number }[]>`
  SELECT id::text, adjustment_no, company_id::int AS company_id FROM scm.stock_adjustments ORDER BY adjustment_no`;

describePg('stock adjustment document backfill', () => {
  beforeAll(async () => {
    assertDisposableTestDatabase(url);
    sql = postgres(url, { max: 1, prepare: false, fetch_types: false, onnotice: () => {} });
    await sql.unsafe(`
      DROP SCHEMA IF EXISTS scm CASCADE;
      CREATE SCHEMA scm;
      CREATE TABLE IF NOT EXISTS public.companies (id bigint PRIMARY KEY, code text, name text, is_active int);
      INSERT INTO public.companies (id, code) VALUES (1, 'HOUZS'), (2, '2990')
        ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code;
      CREATE TABLE scm.warehouses (id uuid PRIMARY KEY, code text);
      CREATE TABLE scm.inventory_movements (
        id uuid PRIMARY KEY, movement_type text NOT NULL, warehouse_id uuid NOT NULL, item_code text NOT NULL,
        product_name text, variant_key text NOT NULL DEFAULT '', qty integer NOT NULL, unit_cost_sen integer DEFAULT 0,
        source_doc_type text, source_doc_id uuid, source_doc_no text, batch_no text, notes text, performed_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(), company_id bigint NOT NULL, variants jsonb, description2 text,
        reason_code text);
      CREATE TABLE scm.inventory_lots (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), movement_id uuid, source_doc_type text, source_doc_id uuid, source_doc_no text);
      CREATE TABLE scm.inventory_lot_consumptions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), movement_id uuid, source_doc_type text, source_doc_id uuid, source_doc_no text);
    `);
    await applyDocNoCounterMigration(sql);
    await sql`INSERT INTO scm.warehouses (id, code) VALUES (${WH}, 'KL')`;
    // Inserted out of creation order on purpose: numbering follows created_at.
    await sql.unsafe(`
      INSERT INTO scm.inventory_movements
        (id, movement_type, warehouse_id, item_code, product_name, qty, unit_cost_sen, source_doc_type, source_doc_id,
         source_doc_no, batch_no, notes, created_at, company_id, reason_code)
      VALUES
        ('${id(1)}', 'ADJUSTMENT', '${WH}', 'CH-1', 'Chair', -2, 900, 'ADJUSTMENT', NULL, NULL, NULL, 'water', '2026-09-20T02:00:00Z', 1, 'DAMAGE'),
        ('${id(2)}', 'ADJUSTMENT', '${WH}', 'CH-2', 'Stool',  5, 400, 'ADJUSTMENT', NULL, NULL, 'B1', NULL,   '2026-09-15T02:00:00Z', 1, 'FOUND'),
        -- 17:30 UTC on 30 Sep is 01:30 on 1 Oct in Malaysia: an October number.
        ('${id(3)}', 'ADJUSTMENT', '${WH}', 'CH-1', 'Chair', -1, 900, 'ADJUSTMENT', NULL, NULL, NULL, NULL,   '2026-09-30T17:30:00Z', 1, 'LOSS'),
        ('${id(4)}', 'ADJUSTMENT', '${WH}', 'CH-9', 'Desk',   1, 100, 'ADJUSTMENT', NULL, NULL, NULL, NULL,   '2026-09-16T02:00:00Z', 2, 'FOUND'),
        -- A DO-cancel add-back is source_doc_type ADJUSTMENT too, but names its DO.
        ('${id(5)}', 'ADJUSTMENT', '${WH}', 'CH-1', 'Chair',  3, 900, 'ADJUSTMENT', '${DO_ID}', 'HC-DO-2609-001', NULL, NULL, '2026-09-18T02:00:00Z', 1, NULL),
        ('${id(6)}', 'ADJUSTMENT', '${WH}', 'CH-1', 'Chair', -1, 900, 'STOCK_TAKE', '${TAKE_ID}', 'HC-STK-2609-001', NULL, NULL, '2026-09-19T02:00:00Z', 1, 'COUNT');
      INSERT INTO scm.inventory_lots (movement_id, source_doc_type) VALUES ('${id(2)}', 'ADJUSTMENT');
      INSERT INTO scm.inventory_lot_consumptions (movement_id, source_doc_type) VALUES ('${id(1)}', 'ADJUSTMENT');
    `);
    await applyBySuffix(sql, '_scm_stock_adjustments.sql');
    await applyBySuffix(sql, '_scm_stock_adjustments_backfill.sql');
  });

  afterAll(async () => {
    if (!sql) return;
    await sql.unsafe('DROP SCHEMA IF EXISTS scm CASCADE;');
    await sql.end();
  });

  test('one document per manual movement, numbered per company and Malaysian month in created_at order', async () => {
    expect(await headers()).toEqual([
      { id: id(4), adjustment_no: '2990-SA-2609-001', company_id: 2 },
      { id: id(2), adjustment_no: 'HC-SA-2609-001', company_id: 1 },
      { id: id(1), adjustment_no: 'HC-SA-2609-002', company_id: 1 },
      { id: id(3), adjustment_no: 'HC-SA-2610-001', company_id: 1 },
    ]);
  });

  test('each document carries its movement as its one line', async () => {
    const lines = await sql<{ doc: string; item_code: string; qty: number; batch_no: string | null; reason_code: string | null; notes: string | null }[]>`
      SELECT stock_adjustment_id::text AS doc, item_code, qty, batch_no, reason_code, notes
        FROM scm.stock_adjustment_lines ORDER BY item_code, qty`;
    expect(lines).toEqual([
      { doc: id(1), item_code: 'CH-1', qty: -2, batch_no: null, reason_code: 'DAMAGE', notes: 'water' },
      { doc: id(3), item_code: 'CH-1', qty: -1, batch_no: null, reason_code: 'LOSS', notes: null },
      { doc: id(2), item_code: 'CH-2', qty: 5, batch_no: 'B1', reason_code: 'FOUND', notes: null },
      { doc: id(4), item_code: 'CH-9', qty: 1, batch_no: null, reason_code: 'FOUND', notes: null },
    ]);
  });

  test('the movement, its lot and its consumptions point at the document; DO and stock-take rows are untouched', async () => {
    const mv = await sql<{ id: string; source_doc_id: string | null; source_doc_no: string | null }[]>`
      SELECT id::text, source_doc_id::text, source_doc_no FROM scm.inventory_movements ORDER BY id`;
    expect(mv).toEqual([
      { id: id(1), source_doc_id: id(1), source_doc_no: 'HC-SA-2609-002' },
      { id: id(2), source_doc_id: id(2), source_doc_no: 'HC-SA-2609-001' },
      { id: id(3), source_doc_id: id(3), source_doc_no: 'HC-SA-2610-001' },
      { id: id(4), source_doc_id: id(4), source_doc_no: '2990-SA-2609-001' },
      { id: id(5), source_doc_id: DO_ID, source_doc_no: 'HC-DO-2609-001' },
      { id: id(6), source_doc_id: TAKE_ID, source_doc_no: 'HC-STK-2609-001' },
    ]);
    expect(await sql`SELECT source_doc_no FROM scm.inventory_lots`).toEqual([{ source_doc_no: 'HC-SA-2609-001' }]);
    expect(await sql`SELECT source_doc_no FROM scm.inventory_lot_consumptions`).toEqual([{ source_doc_no: 'HC-SA-2609-002' }]);
  });

  test('the counter is raised past every number used, so the first live mint follows on', async () => {
    const rows = await sql<{ series: string; next_n: number }[]>`
      SELECT series, next_n FROM scm.doc_number_counters WHERE series LIKE '%SA-%' ORDER BY series`;
    expect(rows).toEqual([
      { series: '2990-SA-2609', next_n: 2 },
      { series: 'HC-SA-2609', next_n: 3 },
      { series: 'HC-SA-2610', next_n: 2 },
    ]);
  });

  test('re-running the backfill changes nothing', async () => {
    const before = await headers();
    await applyBySuffix(sql, '_scm_stock_adjustments_backfill.sql');
    expect(await headers()).toEqual(before);
    expect((await sql`SELECT count(*)::int AS n FROM scm.stock_adjustment_lines`)[0]!.n).toBe(4);
  });
});
