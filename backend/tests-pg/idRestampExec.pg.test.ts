import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { execIdRestamp, execDedupe } from '../scripts/lib/id-restamp-exec.mjs';
import { classifyDuplicateMovement } from '../scripts/lib/ledger-repair-core.mjs';

/* END-TO-END PROOF of the id-restamp executor against REAL Postgres savepoint
 * semantics and a REAL partial unique index — the two things the unit suite
 * cannot fake, and the two things that broke the first two live APPLYs of
 * repair-2990-doc-refs part `ids` (2026-08-01):
 *   round 1: a dangling movement restamped onto the real DO id collided with a
 *            movement the document already carries (uq_inv_mov_do_source) and
 *            the group-level UPDATE aborted everything;
 *   round 2: with per-statement savepoints, one collision was classified and a
 *            SECOND (intra-batch self-collision) still surfaced raw.
 * This suite drives the ACTUAL exported executor — not a re-enactment — at a
 * scratch schema shaped like the ledger tables, with a partial unique index
 * mirroring uq_inv_mov_do_source's documented shape (DO-source rows, keyed
 * without movement_type). It pins: clean rows COMMIT no matter how many
 * duplicates are classified; a duplicate movement's consumptions roll back
 * WITH it (the pair never splits); the second of two dangling rows restamping
 * to the SAME key is CLASSIFIED, not thrown; the dry-run (commit:false)
 * exercises identically and persists nothing; and a re-run is coherent.
 *
 * Runs against CI's postgres:16 service container (`backend-postgres` ->
 * `npm run test:pg`); SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const SCHEMA = 'idrestamp_t';
const REAL = '00000000-0000-0000-0000-00000000aaaa';
const DEAD1 = '00000000-0000-0000-0000-00000000dead';
const DEAD2 = '00000000-0000-0000-0000-0000dead2222';
const WH = '00000000-0000-0000-0000-00000000beef';
const R1 = '10000000-0000-0000-0000-000000000001'; // real movement, bucket P1
const D1 = '20000000-0000-0000-0000-000000000001'; // dangling, bucket P1 -> duplicate-of-real
const D2 = '20000000-0000-0000-0000-000000000002'; // dangling, bucket P2 -> clean
const D3 = '20000000-0000-0000-0000-000000000003'; // dangling, bucket P3 -> clean (first)
const D4 = '20000000-0000-0000-0000-000000000004'; // dangling, bucket P3 -> self-collision (second)
const R4 = '10000000-0000-0000-0000-000000000004'; // real movement, bucket P4, qty 5
const D6 = '20000000-0000-0000-0000-000000000006'; // dangling, bucket P4, qty 9 -> collides, NOT a twin
const C1 = '30000000-0000-0000-0000-000000000001'; // consumption of D1 (must roll back with it)
const C2 = '30000000-0000-0000-0000-000000000002'; // consumption of D2 (commits with it)
const C5 = '30000000-0000-0000-0000-000000000005'; // standalone consumption (movement_id NULL)
const LOT1 = '40000000-0000-0000-0000-000000000001'; // the lot D1's consumption decremented

const PLAN = [{
  companyId: 2,
  docType: 'DO',
  docNo: '2990-DO-TEST-1',
  resolvedDocId: REAL,
  idWrites: [
    { action: 'restamp', id: DEAD1, rows: 0 },
    { action: 'restamp', id: DEAD2, rows: 0 },
  ],
}];

let admin: Sql;

async function movementDocId(id: string): Promise<string | null> {
  const r = await admin.unsafe(`SELECT source_doc_id::text AS d FROM "${SCHEMA}".inventory_movements WHERE id = $1`, [id]);
  return (r[0] as { d: string | null } | undefined)?.d ?? null;
}
async function consumptionDocId(id: string): Promise<string | null> {
  const r = await admin.unsafe(`SELECT source_doc_id::text AS d FROM "${SCHEMA}".inventory_lot_consumptions WHERE id = $1`, [id]);
  return (r[0] as { d: string | null } | undefined)?.d ?? null;
}

describePg('execIdRestamp against real Postgres (savepoints + a real partial unique index)', () => {
  beforeAll(async () => {
    admin = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.unsafe(`CREATE SCHEMA "${SCHEMA}"`);
    await admin.unsafe(`
      CREATE TABLE "${SCHEMA}".inventory_movements (
        id uuid PRIMARY KEY,
        company_id int NOT NULL,
        movement_type text NOT NULL DEFAULT 'OUT',
        qty int NOT NULL DEFAULT 1,
        unit_cost_sen int NOT NULL DEFAULT 0,
        total_cost_sen int NOT NULL DEFAULT 0,
        movement_date date,
        source_doc_type text,
        source_doc_no text,
        source_doc_id uuid,
        warehouse_id uuid NOT NULL,
        item_code text NOT NULL,
        variant_key text NOT NULL DEFAULT '',
        batch_no text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await admin.unsafe(`
      CREATE TABLE "${SCHEMA}".inventory_lot_consumptions (
        id uuid PRIMARY KEY,
        company_id int NOT NULL,
        qty_consumed int NOT NULL DEFAULT 1,
        unit_cost_sen int NOT NULL DEFAULT 0,
        total_cost_sen int NOT NULL DEFAULT 0,
        source_doc_type text,
        source_doc_no text,
        source_doc_id uuid,
        movement_id uuid,
        lot_id uuid
      )`);
    await admin.unsafe(`
      CREATE TABLE "${SCHEMA}".inventory_lots (
        id uuid PRIMARY KEY,
        qty_remaining int NOT NULL DEFAULT 0
      )`);
    /* The documented shape of uq_inv_mov_do_source: partial over DO-source
       rows, keyed WITHOUT movement_type — so two DO rows of one document in
       one bucket collide. The exact prod definition is not in-tree (PR #674
       applied it by hand), which is precisely why the executor catches 23505
       instead of precomputing the key; any unique index raises the same class. */
    await admin.unsafe(`
      CREATE UNIQUE INDEX uq_test_mov_do_source
        ON "${SCHEMA}".inventory_movements (source_doc_id, warehouse_id, item_code, variant_key, COALESCE(batch_no, ''))
        WHERE source_doc_type = 'DO'`);
  });

  afterAll(async () => {
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await admin.unsafe(`TRUNCATE "${SCHEMA}".inventory_movements, "${SCHEMA}".inventory_lot_consumptions, "${SCHEMA}".inventory_lots`);
    const mov = (id: string, docId: string, product: string, qty = 2) =>
      admin.unsafe(
        `INSERT INTO "${SCHEMA}".inventory_movements (id, company_id, movement_type, qty, total_cost_sen, source_doc_type, source_doc_no, source_doc_id, warehouse_id, item_code)
         VALUES ($1, 2, 'OUT', $5, 100, 'DO', '2990-DO-TEST-1', $2, $3, $4)`,
        [id, docId, WH, product, qty],
      );
    await mov(R1, REAL, 'P1'); // the real document already carries bucket P1 (OUT qty 2)
    await mov(D1, DEAD1, 'P1'); // import duplicate of R1 — FULL-ROW twin (same type + qty)
    await mov(D2, DEAD1, 'P2'); // clean restamp
    await mov(D3, DEAD1, 'P3'); // clean restamp (first of the self-colliding pair)
    await mov(D4, DEAD2, 'P3'); // self-collision with D3 after ITS restamp (same qty as D3)
    await mov(R4, REAL, 'P4', 5); // real bucket-P4 movement with a DIFFERENT qty
    await mov(D6, DEAD1, 'P4', 9); // collides on the index with R4, but qty differs — NOT a twin
    await admin.unsafe(`INSERT INTO "${SCHEMA}".inventory_lots (id, qty_remaining) VALUES ($1, 3)`, [LOT1]);
    const cons = (id: string, docId: string, movementId: string | null, lotId: string | null = null) =>
      admin.unsafe(
        `INSERT INTO "${SCHEMA}".inventory_lot_consumptions (id, company_id, qty_consumed, source_doc_type, source_doc_no, source_doc_id, movement_id, lot_id)
         VALUES ($1, 2, 2, 'DO', '2990-DO-TEST-1', $2, $3, $4)`,
        [id, docId, movementId, lotId],
      );
    await cons(C1, DEAD1, D1, LOT1); // the duplicate's consumption — deleting it must RESTORE LOT1
    await cons(C2, DEAD1, D2);
    await cons(C5, DEAD1, null);
  });

  test('dry run (commit:false) classifies both collision shapes, would-commit the clean rows, persists NOTHING', async () => {
    const out = await execIdRestamp(admin, PLAN, { commit: false, schema: SCHEMA });
    expect(out.movements).toBe(2); // D2 + D3
    expect(out.consumptions).toBe(2); // C2 (with D2) + C5 (standalone)
    expect(out.duplicates).toHaveLength(3); // D1 (pre-existing twin) + D4 (self-collision) + D6 (index collision, qty differs)
    const d1 = out.duplicates.find((d: { rowId: string }) => d.rowId === D1);
    const d4 = out.duplicates.find((d: { rowId: string }) => d.rowId === D4);
    expect(d1?.consumptionsFollowing).toBe(1); // C1 rolled back with its movement
    expect(d1?.constraint).toBe('uq_test_mov_do_source');
    expect(d4?.maySelfCollide).toBe(true); // a sibling restamped earlier in this run
    // Nothing persisted:
    for (const [id, want] of [[D1, DEAD1], [D2, DEAD1], [D3, DEAD1], [D4, DEAD2], [D6, DEAD1]] as const) {
      expect(await movementDocId(id), id).toBe(want);
    }
    expect(await consumptionDocId(C1)).toBe(DEAD1);
    expect(await consumptionDocId(C2)).toBe(DEAD1);
    expect(await consumptionDocId(C5)).toBe(DEAD1);
  });

  test('APPLY commits the clean rows no matter how many duplicates are classified; the duplicate PAIR stays together', async () => {
    const out = await execIdRestamp(admin, PLAN, { commit: true, schema: SCHEMA });
    expect(out.movements).toBe(2);
    expect(out.consumptions).toBe(2);
    expect(out.duplicates).toHaveLength(3);
    // Clean rows committed:
    expect(await movementDocId(D2)).toBe(REAL);
    expect(await movementDocId(D3)).toBe(REAL);
    expect(await consumptionDocId(C2)).toBe(REAL);
    expect(await consumptionDocId(C5)).toBe(REAL);
    // Duplicates untouched — reported, never deleted, pair intact:
    expect(await movementDocId(D1)).toBe(DEAD1);
    expect(await movementDocId(D4)).toBe(DEAD2);
    expect(await consumptionDocId(C1)).toBe(DEAD1);
    const count = await admin.unsafe(`SELECT count(*)::int AS n FROM "${SCHEMA}".inventory_movements`);
    expect((count[0] as { n: number }).n).toBe(7); // nothing deleted
  });

  test('re-running after APPLY is coherent: restamped rows leave the dangling set; only the classified duplicates remain', async () => {
    await execIdRestamp(admin, PLAN, { commit: true, schema: SCHEMA });
    const again = await execIdRestamp(admin, PLAN, { commit: true, schema: SCHEMA });
    expect(again.movements).toBe(0);
    expect(again.consumptions).toBe(0);
    expect(again.duplicates).toHaveLength(3); // D1 + D4 + D6, classified again, still not deleted
    expect(await movementDocId(D1)).toBe(DEAD1);
    expect(await movementDocId(D4)).toBe(DEAD2);
  });

  test('the poisoned-transaction belt: a non-23505 error aborts the WHOLE run and commits nothing', async () => {
    // Force a non-unique failure mid-run: drop a column the executor updates.
    await admin.unsafe(`ALTER TABLE "${SCHEMA}".inventory_lot_consumptions DROP COLUMN source_doc_id`);
    await expect(execIdRestamp(admin, PLAN, { commit: true, schema: SCHEMA })).rejects.toThrow();
    await admin.unsafe(`ALTER TABLE "${SCHEMA}".inventory_lot_consumptions ADD COLUMN source_doc_id uuid`);
    // The movement half of the aborted run must NOT have committed:
    expect(await movementDocId(D2)).toBe(DEAD1);
    expect(await movementDocId(D3)).toBe(DEAD1);
  });

  /* part=dedupe (owner-authorized removal): the deletion rule is STRICTER than
   * the index collision — a FULL-ROW twin must exist on the real document.
   * D1 (twin of R1: same type + qty) deletes, its consumption goes with it and
   * the consumed lot is RESTORED; D6 (collides with R4 but qty 9 vs 5) refuses;
   * D4's twin only materialises after part=ids APPLY restamps D3 — the
   * documented run order ids -> dedupe, pinned here. */
  test('dedupe dry run: twin deletable, non-twin refused, nothing persisted', async () => {
    const res = await execDedupe(admin, PLAN, classifyDuplicateMovement, { commit: false, schema: SCHEMA });
    expect(res.deletable.map((c: { movement: { id: string } }) => c.movement.id)).toEqual([D1]);
    const refusedIds = res.refused.map((c: { movement: { id: string } }) => c.movement.id).sort();
    expect(refusedIds).toEqual([D4, D6]); // D4: its twin (D3) is not on the real doc yet; D6: qty differs
    const d1 = res.deletable[0];
    expect(d1.consumptions).toHaveLength(1);
    expect(d1.consumptions[0].lot_exists).toBe(true);
    // Nothing persisted:
    expect(await movementDocId(D1)).toBe(DEAD1);
    const lot = await admin.unsafe(`SELECT qty_remaining FROM "${SCHEMA}".inventory_lots WHERE id = $1`, [LOT1]);
    expect((lot[0] as { qty_remaining: number }).qty_remaining).toBe(3);
  });

  test('dedupe APPLY: deletes the pair, RESTORES the lot, leaves refusals untouched — one transaction', async () => {
    const res = await execDedupe(admin, PLAN, classifyDuplicateMovement, { commit: true, schema: SCHEMA });
    expect(res.deletedMovements).toBe(1);
    expect(res.deletedConsumptions).toBe(1);
    expect(res.lotsRestored).toBe(1);
    expect(await movementDocId(D1)).toBeNull(); // deleted
    expect(await consumptionDocId(C1)).toBeNull(); // deleted with it
    const lot = await admin.unsafe(`SELECT qty_remaining FROM "${SCHEMA}".inventory_lots WHERE id = $1`, [LOT1]);
    expect((lot[0] as { qty_remaining: number }).qty_remaining).toBe(5); // 3 + the duplicate's 2 restored
    // Refusals and real rows untouched:
    expect(await movementDocId(D6)).toBe(DEAD1);
    expect(await movementDocId(R1)).toBe(REAL);
    expect(await movementDocId(R4)).toBe(REAL);
  });

  test('run order ids -> dedupe: the self-collision twin becomes deletable once its sibling is on the real document', async () => {
    await execIdRestamp(admin, PLAN, { commit: true, schema: SCHEMA }); // D3 lands on REAL
    const res = await execDedupe(admin, PLAN, classifyDuplicateMovement, { commit: true, schema: SCHEMA });
    const deleted = res.deletable.map((c: { movement: { id: string } }) => c.movement.id).sort();
    expect(deleted).toEqual([D1, D4]); // D4's twin is now the restamped D3
    expect(await movementDocId(D4)).toBeNull();
    expect(await movementDocId(D3)).toBe(REAL); // the twin that stays
    expect(res.refused.map((c: { movement: { id: string } }) => c.movement.id)).toEqual([D6]); // still no twin
    // Idempotence: a second dedupe finds nothing deletable.
    const again = await execDedupe(admin, PLAN, classifyDuplicateMovement, { commit: true, schema: SCHEMA });
    expect(again.deletable).toHaveLength(0);
  });
});
