import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

/* END-TO-END PROOF that editing a SHIPPED delivery order can reach the stock
 * ledger, against real Postgres.
 *
 * THE CLAIM THIS SUITE HAS TO SETTLE. Production carries a PARTIAL UNIQUE index
 * that exists in no file in this repo:
 *
 *   CREATE UNIQUE INDEX uq_inv_mov_do_source ON scm.inventory_movements
 *     USING btree (source_doc_type, source_doc_id, item_code, variant_key)
 *     WHERE (source_doc_type = 'DO'::text)
 *
 * movement_type is not in that key, so one (DO, product, variant) bucket holds
 * exactly ONE row. resyncInventoryForDo — the edit-after-ship path — writes
 * DELTA rows into that same bucket, so every one of them was rejected. Measured
 * against production 2026-08-11: ZERO movements carry that function's own notes
 * marker. It had never landed a single row.
 *
 * The suite builds the index EXACTLY as production has it (that is the whole
 * point: no file had it, so the fixture is where it becomes checkable), proves
 * the rejection is real, then applies migration 0279 and proves four things:
 *
 *   1. a first correction now lands;
 *   2. a SECOND correction on the same bucket also lands — the case that rules
 *      out "just add movement_type to the index", which would have permitted
 *      exactly one row per direction and failed on the operator's second edit;
 *   3. a double-post of the FIRST SHIP is still rejected — the backstop the old
 *      index existed for is not weakened;
 *   4. the new index is buildable over data that satisfied the old one, because
 *      every existing row folds to COALESCE(correction_seq, 0) = 0.
 *
 * Runs against CI's postgres:16 service container (`backend-postgres` ->
 * `npm run test:pg`); SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

// By SUFFIX, never by number — parallel PRs renumber migrations routinely, and a
// number-pinned read would silently resolve to nothing and pass vacuously.
async function correctionSeqMigrationSql(): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_scm_inv_mov_correction_seq.sql'));
  if (files.length !== 1) {
    throw new Error(
      `expected exactly one *_scm_inv_mov_correction_seq.sql migration, found ${files.length}: ${files.join(', ')}`,
    );
  }
  return (await readFile(join(migrationsDir, files[0]!), 'utf8')).replace(/\bproduct_code\b/g, 'item_code').replace(/\bmaterial_code\b/g, 'item_code');
}

const WH = '11111111-1111-1111-1111-111111111111';
const DO_ID = '33333333-3333-3333-3333-333333333333';
const CODE = 'TRION-(K)';
const VKEY = '';

let admin: Sql;

/* inventory_movements is created WITHOUT correction_seq on purpose: the
 * migration's ALTER has to be what puts it there, so a broken ALTER fails here
 * rather than in a deploy. The four partial UNIQUE indexes are created exactly
 * as production carries them — verbatim from pg_indexes, Actions run
 * 31426819498 — because that prod-only DDL is the entire defect. */
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
      total_cost_sen integer DEFAULT 0,
      unit_cost_sen integer DEFAULT 0,
      notes text,
      performed_by uuid,
      company_id integer DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX uq_inv_mov_do_source ON scm.inventory_movements
      USING btree (source_doc_type, source_doc_id, item_code, variant_key)
      WHERE (source_doc_type = 'DO'::text);
    CREATE UNIQUE INDEX uq_inv_mov_dr_source ON scm.inventory_movements
      USING btree (source_doc_type, source_doc_id, item_code, variant_key)
      WHERE (source_doc_type = 'DR'::text);
    CREATE UNIQUE INDEX uq_inv_mov_cs_do_source ON scm.inventory_movements
      USING btree (source_doc_type, source_doc_id, item_code, variant_key)
      WHERE (source_doc_type = 'CS_DO'::text);
    CREATE UNIQUE INDEX uq_inv_mov_cs_dr_source ON scm.inventory_movements
      USING btree (source_doc_type, source_doc_id, item_code, variant_key)
      WHERE (source_doc_type = 'CS_DR'::text);
  `);
}

/** The first ship, as deductInventoryForDo writes it: no correction_seq. */
async function firstShip(sql: Sql, qty = 5): Promise<void> {
  await sql`
    INSERT INTO scm.inventory_movements
      (movement_type, warehouse_id, item_code, variant_key, qty,
       source_doc_type, source_doc_id, source_doc_no, notes)
    VALUES ('OUT', ${WH}, ${CODE}, ${VKEY}, ${qty},
            'DO', ${DO_ID}, 'DO-TEST-001', 'First ship')`;
}

/** One resync delta, as resyncInventoryForDo writes it AFTER 0279. */
function correction(sql: Sql, movementType: 'IN' | 'OUT', qty: number, seq: number | null) {
  return sql`
    INSERT INTO scm.inventory_movements
      (movement_type, warehouse_id, item_code, variant_key, qty,
       source_doc_type, source_doc_id, source_doc_no, correction_seq, notes)
    VALUES (${movementType}, ${WH}, ${CODE}, ${VKEY}, ${qty},
            'DO', ${DO_ID}, 'DO-TEST-001', ${seq},
            'Resync: line qty reduced / line deleted (shipped DO).')`;
}

describePg('editing a shipped DO reaches the stock ledger (migration 0279)', () => {
  beforeAll(async () => { admin = postgres(url, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await admin?.end({ timeout: 5 }); });
  beforeEach(async () => { await resetFixture(admin); });

  test('BEFORE the migration: the delta row is REJECTED — the defect, reproduced', async () => {
    await firstShip(admin);
    /* Same bucket, opposite direction. movement_type is not in the key, so this
       is a duplicate key. This is what production has been doing silently. */
    await expect(admin`
      INSERT INTO scm.inventory_movements
        (movement_type, warehouse_id, item_code, variant_key, qty,
         source_doc_type, source_doc_id, source_doc_no, notes)
      VALUES ('IN', ${WH}, ${CODE}, ${VKEY}, 2,
              'DO', ${DO_ID}, 'DO-TEST-001', 'Resync: line qty reduced.')`,
    ).rejects.toThrow(/uq_inv_mov_do_source|duplicate key/i);

    const [{ n }] = await admin`SELECT COUNT(*)::int AS n FROM scm.inventory_movements`;
    expect(n).toBe(1); // the edit changed the paperwork; the ledger did not move
  });

  test('the migration builds over data the OLD index already accepted', async () => {
    // Two DIFFERENT buckets plus a DR row — a realistic pre-migration ledger.
    await firstShip(admin);
    await admin`
      INSERT INTO scm.inventory_movements
        (movement_type, warehouse_id, item_code, variant_key, qty, source_doc_type, source_doc_id)
      VALUES ('OUT', ${WH}, 'OTHER-SKU', '', 1, 'DO', ${DO_ID})`;
    await expect(admin.unsafe(await correctionSeqMigrationSql())).resolves.toBeDefined();

    const idx = await admin`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'scm' AND tablename = 'inventory_movements' ORDER BY 1`;
    const names = idx.map((r) => r.indexname);
    expect(names).toContain('uq_inv_mov_do_source_v2');
    expect(names).not.toContain('uq_inv_mov_do_source'); // replaced, not duplicated
    // The three siblings are now recorded in the repo, unchanged.
    expect(names).toEqual(expect.arrayContaining([
      'uq_inv_mov_dr_source', 'uq_inv_mov_cs_do_source', 'uq_inv_mov_cs_dr_source',
    ]));
  });

  describe('AFTER the migration', () => {
    beforeEach(async () => { await admin.unsafe(await correctionSeqMigrationSql()); });

    test('the first correction LANDS — the fix', async () => {
      await firstShip(admin);
      await expect(correction(admin, 'IN', 2, 1)).resolves.toBeDefined();

      const [row] = await admin`
        SELECT SUM(CASE WHEN movement_type = 'OUT' THEN qty ELSE -qty END)::int AS net_out
          FROM scm.inventory_movements
         WHERE source_doc_type = 'DO' AND source_doc_id = ${DO_ID}`;
      expect(row.net_out).toBe(3); // shipped 5, operator reduced the line to 3
    });

    test('a SECOND correction on the same bucket also lands', async () => {
      /* This is the case that rules out the alternative fix shape. Adding
         movement_type to the index would have allowed exactly one IN and one
         OUT per bucket, so the operator's SECOND edit would still have been
         rejected — and a half-fix on a silent money path is worse than none. */
      await firstShip(admin);
      await correction(admin, 'IN', 2, 1);
      await expect(correction(admin, 'IN', 1, 2)).resolves.toBeDefined();

      const [row] = await admin`
        SELECT SUM(CASE WHEN movement_type = 'OUT' THEN qty ELSE -qty END)::int AS net_out
          FROM scm.inventory_movements
         WHERE source_doc_type = 'DO' AND source_doc_id = ${DO_ID}`;
      expect(row.net_out).toBe(2); // 5 shipped, reduced to 3, then to 2
    });

    test('the DOUBLE-POST backstop is NOT weakened: a second first-ship is still rejected', async () => {
      await firstShip(admin);
      await expect(firstShip(admin)).rejects.toThrow(/uq_inv_mov_do_source_v2|duplicate key/i);
    });

    test('two corrections cannot reuse the SAME sequence number', async () => {
      await firstShip(admin);
      await correction(admin, 'IN', 2, 1);
      await expect(correction(admin, 'IN', 1, 1)).rejects.toThrow(/uq_inv_mov_do_source_v2|duplicate key/i);
    });

    test('a NULL correction_seq still folds to the single primary slot', async () => {
      /* COALESCE is what makes this true. A bare correction_seq column in the
         key would let two NULLs coexist — SQL NULLs are distinct — and the
         double-post backstop would be silently gone. */
      await firstShip(admin);
      await expect(correction(admin, 'IN', 2, null)).rejects.toThrow(/uq_inv_mov_do_source_v2|duplicate key/i);
    });

    test('other source_doc_types are untouched by the new key', async () => {
      // A DR bucket still allows exactly one row, correction_seq or not.
      await admin`
        INSERT INTO scm.inventory_movements
          (movement_type, warehouse_id, item_code, variant_key, qty, source_doc_type, source_doc_id)
        VALUES ('IN', ${WH}, ${CODE}, ${VKEY}, 1, 'DR', ${DO_ID})`;
      await expect(admin`
        INSERT INTO scm.inventory_movements
          (movement_type, warehouse_id, item_code, variant_key, qty, source_doc_type, source_doc_id, correction_seq)
        VALUES ('OUT', ${WH}, ${CODE}, ${VKEY}, 1, 'DR', ${DO_ID}, 1)`,
      ).rejects.toThrow(/uq_inv_mov_dr_source|duplicate key/i);
    });

    test('the migration is idempotent — re-applying it changes nothing', async () => {
      await firstShip(admin);
      await correction(admin, 'IN', 2, 1);
      await expect(admin.unsafe(await correctionSeqMigrationSql())).resolves.toBeDefined();
      const [{ n }] = await admin`SELECT COUNT(*)::int AS n FROM scm.inventory_movements`;
      expect(n).toBe(2);
    });
  });
});
