import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

/* END-TO-END PROOF that reducing a line on a SHIPPED delivery order returns the
 * stock at its ORIGINAL cost, against real Postgres.
 *
 * THE DEFECT (audit ledger B6, owner decision 2026-08-13 "按原成本退回").
 * resyncInventoryForDo returned stock at the bucket's weighted average:
 *
 *     unit_cost_sen = round(out_total_cost / out_qty)
 *
 * That blends units that HAVE a cost with units that do not. A "ship anyway"
 * oversell leaves its short units with no lot consumption, contributing 0 to the
 * total, so returning 4 of an OUT of 10 where 6 cost 100 sen and 4 cost nothing
 * hands back 60 sen/unit — too much if the returned units were the uncosted ones,
 * too little if they were the costed ones — and MINTS A LOT at that invented
 * figure, which the next FIFO consumer then eats.
 *
 * The answer was recorded when the stock left: inventory_lot_consumptions says
 * which lot paid for which unit. fn_return_do_units_at_cost unwinds those rows
 * newest-first and gives each unit back to its own lot at its own cost.
 *
 * This suite is where that becomes checkable, because the whole mechanism is
 * cross-table (lots + consumptions + movements) and a fake PostgREST client has
 * no lots. It proves:
 *
 *   1. the blend is REAL and WRONG on the fixture — the arithmetic the fix
 *      replaces, asserted before asserting the fix, so a passing suite cannot be
 *      passing vacuously;
 *   2. a partial return restores the ORIGINAL lots at their ORIGINAL costs, LIFO;
 *   3. consumption rows shrink or disappear, and the OUT's COGS is restamped to
 *      what is still shipped;
 *   4. units with no consumption behind them come back at NOTHING and are
 *      reported, never smeared into a per-unit cost;
 *   5. the balancing IN carries cost 0 — the value went back to the lots, and
 *      pricing it again would capitalise it twice;
 *   6. two successive reductions both land (this is not a cancel; the same
 *      bucket may legitimately be reduced more than once).
 *
 * Runs against CI's postgres:16 service container (`backend-postgres` ->
 * `npm run test:pg`); SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

// By SUFFIX, never by number — parallel PRs renumber migrations routinely, and a
// number-pinned read would silently resolve to nothing and pass vacuously.
async function returnAtCostMigrationSql(): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_scm_return_do_units_at_cost.sql'));
  if (files.length !== 1) {
    throw new Error(
      `expected exactly one *_scm_return_do_units_at_cost.sql migration, found ${files.length}: ${files.join(', ')}`,
    );
  }
  return (await readFile(join(migrationsDir, files[0]!), 'utf8')).replace(/\bproduct_code\b/g, 'item_code').replace(/\bmaterial_code\b/g, 'item_code');
}

const WH = '11111111-1111-1111-1111-111111111111';
const DO_ID = '33333333-3333-3333-3333-333333333333';
const USER = '44444444-4444-4444-4444-444444444444';
const CODE = 'TRION-(K)';

let admin: Sql;

async function resetFixture(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') {
    throw new Error('PG integration tests require the disposable houzs_test database');
  }

  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS scm;
    DROP TABLE IF EXISTS scm.inventory_lot_consumptions CASCADE;
    DROP TABLE IF EXISTS scm.inventory_lots CASCADE;
    DROP TABLE IF EXISTS scm.inventory_movements CASCADE;

    CREATE TABLE scm.inventory_movements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      movement_type text,
      warehouse_id uuid,
      item_code text,
      variant_key text DEFAULT '' NOT NULL,
      product_name text,
      qty integer,
      batch_no text,
      movement_date date,
      source_doc_type text,
      source_doc_id uuid,
      source_doc_no text,
      correction_seq integer,
      total_cost_sen bigint DEFAULT 0,
      unit_cost_sen bigint DEFAULT 0,
      notes text,
      performed_by uuid,
      company_id integer DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE scm.inventory_lots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      movement_id uuid,
      warehouse_id uuid,
      item_code text,
      variant_key text DEFAULT '' NOT NULL,
      qty_received integer NOT NULL,
      qty_remaining integer NOT NULL,
      unit_cost_sen bigint NOT NULL,
      company_id integer DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE scm.inventory_lot_consumptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lot_id uuid,
      warehouse_id uuid,
      item_code text,
      variant_key text DEFAULT '' NOT NULL,
      qty_consumed integer NOT NULL,
      unit_cost_sen bigint,
      total_cost_sen bigint,
      source_doc_type text,
      source_doc_id uuid,
      source_doc_no text,
      movement_id uuid,
      created_by uuid,
      company_id integer DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    -- The production idempotency backstop (0279). Present so the balancing IN
    -- has to carry a correct correction_seq rather than passing by its absence.
    CREATE UNIQUE INDEX uq_inv_mov_do_source_v2 ON scm.inventory_movements
      USING btree (source_doc_type, source_doc_id, item_code, variant_key, COALESCE(correction_seq, 0))
      WHERE (source_doc_type = 'DO'::text);
  `);
}

/** Two lots at different costs, and ONE ship of 10 that consumed 6 of them and
 *  went short on the other 4 — the "ship anyway" oversell the blend mishandles.
 *  Lot A: 2 units @ 100 sen. Lot B: 4 units @ 250 sen. 4 units uncosted. */
async function shipTenWithFourUncosted(sql: Sql): Promise<{ outId: string; lotA: string; lotB: string }> {
  const [out] = await sql<{ id: string }[]>`
    INSERT INTO scm.inventory_movements
      (movement_type, warehouse_id, item_code, variant_key, product_name, qty,
       source_doc_type, source_doc_id, source_doc_no, total_cost_sen, unit_cost_sen)
    VALUES ('OUT', ${WH}, ${CODE}, '', 'Trion King', 10,
            'DO', ${DO_ID}, 'DO-2608-001', ${2 * 100 + 4 * 250}, ${Math.round((2 * 100 + 4 * 250) / 10)})
    RETURNING id
  `;
  const [a] = await sql<{ id: string }[]>`
    INSERT INTO scm.inventory_lots (warehouse_id, item_code, variant_key, qty_received, qty_remaining, unit_cost_sen)
    VALUES (${WH}, ${CODE}, '', 2, 0, 100) RETURNING id
  `;
  const [b] = await sql<{ id: string }[]>`
    INSERT INTO scm.inventory_lots (warehouse_id, item_code, variant_key, qty_received, qty_remaining, unit_cost_sen)
    VALUES (${WH}, ${CODE}, '', 4, 0, 250) RETURNING id
  `;
  // Consumed oldest-first at ship time: lot A, then lot B. created_at ordering is
  // what the function unwinds by, so it is set explicitly rather than left to
  // insert order resolving to the same microsecond.
  await sql`
    INSERT INTO scm.inventory_lot_consumptions
      (lot_id, warehouse_id, item_code, variant_key, qty_consumed, unit_cost_sen, total_cost_sen,
       source_doc_type, source_doc_id, source_doc_no, movement_id, created_by, created_at)
    VALUES (${a!.id}, ${WH}, ${CODE}, '', 2, 100, 200,
            'DO', ${DO_ID}, 'DO-2608-001', ${out!.id}, ${USER}, now() - interval '2 minutes'),
           (${b!.id}, ${WH}, ${CODE}, '', 4, 250, 1000,
            'DO', ${DO_ID}, 'DO-2608-001', ${out!.id}, ${USER}, now() - interval '1 minute')
  `;
  return { outId: out!.id, lotA: a!.id, lotB: b!.id };
}

type ReturnRow = {
  qty_returned: number; qty_costed: number; qty_uncosted: number; cost_restored_sen: string;
};

async function callReturn(sql: Sql, qty: number, seq: number): Promise<ReturnRow> {
  const rows = await sql<ReturnRow[]>`
    SELECT * FROM scm.fn_return_do_units_at_cost(
      ${DO_ID}::uuid, ${WH}::uuid, ${CODE}::text, ''::text, NULL::text,
      ${qty}::integer, ${seq}::integer, ${USER}::uuid, 'test'::text)
  `;
  return rows[0]!;
}

describePg('fn_return_do_units_at_cost — a shipped-line reduction returns stock at ORIGINAL cost', () => {
  beforeAll(async () => {
    admin = postgres(url, { max: 1, onnotice: () => {} });
    await resetFixture(admin);
    await admin.unsafe(await returnAtCostMigrationSql());
  });

  afterAll(async () => { await admin?.end({ timeout: 5 }); });

  beforeEach(async () => {
    await admin`TRUNCATE scm.inventory_lot_consumptions, scm.inventory_lots, scm.inventory_movements`;
  });

  test('THE OLD ARITHMETIC IS WRONG — the blend the fix replaces, asserted first', async () => {
    await shipTenWithFourUncosted(admin);
    const [m] = await admin<{ total_cost_sen: string; qty: number }[]>`
      SELECT total_cost_sen, qty FROM scm.inventory_movements WHERE movement_type = 'OUT'
    `;
    // What resyncInventoryForDo used to compute for a return of 4.
    const blended = Math.round(Number(m!.total_cost_sen) / m!.qty);
    expect(blended).toBe(120);
    // The truth, LIFO: 4 units come off lot B at 250 = 1000 sen, i.e. 250/unit.
    // The blend would have capitalised 4 x 120 = 480 sen for stock worth 1000.
    expect(blended * 4).not.toBe(1000);
  });

  test('restores the ORIGINAL lots at their ORIGINAL costs, newest consumption first', async () => {
    const { lotA, lotB } = await shipTenWithFourUncosted(admin);
    const r = await callReturn(admin, 4, 1);

    expect(r.qty_returned).toBe(4);
    expect(r.qty_costed).toBe(4);
    expect(r.qty_uncosted).toBe(0);
    expect(Number(r.cost_restored_sen)).toBe(1000); // 4 x 250, not 4 x 120

    const [a] = await admin<{ qty_remaining: number }[]>`SELECT qty_remaining FROM scm.inventory_lots WHERE id = ${lotA}`;
    const [b] = await admin<{ qty_remaining: number }[]>`SELECT qty_remaining FROM scm.inventory_lots WHERE id = ${lotB}`;
    expect(b!.qty_remaining).toBe(4); // LIFO: the newest consumption unwound first
    expect(a!.qty_remaining).toBe(0); // the older one is untouched
  });

  test('unwinds ACROSS consumptions when one is not enough, oldest lot last', async () => {
    const { lotA, lotB } = await shipTenWithFourUncosted(admin);
    const r = await callReturn(admin, 5, 1);

    expect(r.qty_costed).toBe(5);
    expect(Number(r.cost_restored_sen)).toBe(4 * 250 + 1 * 100);

    const [a] = await admin<{ qty_remaining: number }[]>`SELECT qty_remaining FROM scm.inventory_lots WHERE id = ${lotA}`;
    const [b] = await admin<{ qty_remaining: number }[]>`SELECT qty_remaining FROM scm.inventory_lots WHERE id = ${lotB}`;
    expect(b!.qty_remaining).toBe(4);
    expect(a!.qty_remaining).toBe(1);

    // The partly-returned consumption shrinks and re-totals; the emptied one goes.
    const cons = await admin<{ qty_consumed: number; total_cost_sen: string }[]>`
      SELECT qty_consumed, total_cost_sen FROM scm.inventory_lot_consumptions ORDER BY unit_cost_sen
    `;
    expect(cons).toHaveLength(1);
    expect(cons[0]!.qty_consumed).toBe(1);
    expect(Number(cons[0]!.total_cost_sen)).toBe(100);
  });

  test('uncosted units come back at NOTHING and are reported, never smeared', async () => {
    await shipTenWithFourUncosted(admin);
    // Return all 10: 6 had a cost behind them, 4 never did.
    const r = await callReturn(admin, 10, 1);

    expect(r.qty_returned).toBe(10);
    expect(r.qty_costed).toBe(6);
    expect(r.qty_uncosted).toBe(4);
    expect(Number(r.cost_restored_sen)).toBe(1200); // 2x100 + 4x250 — the whole real cost, no more
    expect(await admin`SELECT 1 FROM scm.inventory_lot_consumptions`).toHaveLength(0);

    const [inRow] = await admin<{ notes: string }[]>`
      SELECT notes FROM scm.inventory_movements WHERE movement_type = 'IN'
    `;
    expect(inRow!.notes).toContain('4 unit(s) had no cost to return');
  });

  test("restamps the OUT's COGS to what is still shipped", async () => {
    const { outId } = await shipTenWithFourUncosted(admin);
    await callReturn(admin, 4, 1);

    const [out] = await admin<{ total_cost_sen: string; unit_cost_sen: string }[]>`
      SELECT total_cost_sen, unit_cost_sen FROM scm.inventory_movements WHERE id = ${outId}
    `;
    // 1200 shipped, 1000 returned to lot B -> 200 of COGS survives.
    expect(Number(out!.total_cost_sen)).toBe(200);
    expect(Number(out!.unit_cost_sen)).toBe(20); // 200 / qty 10
  });

  test('the balancing IN carries cost 0 — the value went back to the lots', async () => {
    await shipTenWithFourUncosted(admin);
    await callReturn(admin, 4, 1);

    const [inRow] = await admin<{ qty: number; total_cost_sen: string; unit_cost_sen: string; correction_seq: number }[]>`
      SELECT qty, total_cost_sen, unit_cost_sen, correction_seq
        FROM scm.inventory_movements WHERE movement_type = 'IN'
    `;
    expect(inRow!.qty).toBe(4);
    expect(Number(inRow!.total_cost_sen)).toBe(0);
    expect(Number(inRow!.unit_cost_sen)).toBe(0);
    expect(inRow!.correction_seq).toBe(1);
  });

  test('a SECOND reduction on the same bucket also lands — this is not a cancel', async () => {
    const { lotA, lotB } = await shipTenWithFourUncosted(admin);
    const first = await callReturn(admin, 4, 1);
    const second = await callReturn(admin, 2, 2);

    expect(first.qty_costed).toBe(4);
    expect(second.qty_costed).toBe(2);
    expect(Number(second.cost_restored_sen)).toBe(200); // 2 x 100 off lot A

    const [a] = await admin<{ qty_remaining: number }[]>`SELECT qty_remaining FROM scm.inventory_lots WHERE id = ${lotA}`;
    const [b] = await admin<{ qty_remaining: number }[]>`SELECT qty_remaining FROM scm.inventory_lots WHERE id = ${lotB}`;
    expect(b!.qty_remaining).toBe(4);
    expect(a!.qty_remaining).toBe(2);
    expect(await admin`SELECT 1 FROM scm.inventory_movements WHERE movement_type = 'IN'`).toHaveLength(2);
  });

  test('a bucket with NO consumptions returns everything uncosted rather than failing', async () => {
    // A wholly-uncosted ship: OUT exists, nothing was ever costed against it.
    await admin`
      INSERT INTO scm.inventory_movements
        (movement_type, warehouse_id, item_code, variant_key, qty, source_doc_type, source_doc_id, source_doc_no)
      VALUES ('OUT', ${WH}, ${CODE}, '', 3, 'DO', ${DO_ID}, 'DO-2608-002')
    `;
    const r = await callReturn(admin, 3, 1);
    expect(r.qty_returned).toBe(3);
    expect(r.qty_costed).toBe(0);
    expect(r.qty_uncosted).toBe(3);
    expect(Number(r.cost_restored_sen)).toBe(0);
  });

  test('a zero or negative qty is a no-op, not a phantom movement', async () => {
    await shipTenWithFourUncosted(admin);
    const r = await callReturn(admin, 0, 1);
    expect(r.qty_returned).toBe(0);
    expect(await admin`SELECT 1 FROM scm.inventory_movements WHERE movement_type = 'IN'`).toHaveLength(0);
  });
});
