import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { pgTransactionSupabase } from '../src/scm/lib/pg-supabase-transaction';
import { enqueueStockAllocationRecompute } from '../src/scm/lib/stock-allocation-job';
import { buildGrnCancelReversals } from '../src/scm/lib/grn-cancel-reversal';
import { writeMovements } from '../src/scm/lib/inventory-movements';

/* END-TO-END PROOF that a GRN CANCEL — the status flip, the reversing stock OUT
 * and the allocation-recompute request — COMMITS TOGETHER OR NOT AT ALL, against
 * real Postgres, because that property is a transaction property and no unit
 * test can observe it.
 *
 * WHY IT MATTERS, in one sentence: without it, a Worker that dies between the
 * reversing OUT and the recompute leaves stock pulled back off the shelf while
 * SO lines stay marked READY against stock that is no longer there, silently,
 * until some unrelated mutation happens to sweep. `PATCH /grns/:id/cancel` is
 * the second route through docs/ALLOCATION-DURABILITY-PLAN.md, after the line
 * DELETE (grnLineDeleteAtomicity.pg.test.ts, which this is modelled on).
 *
 * WHAT IS AND IS NOT SIMULATED. This does not boot the route — the claim under
 * test is about the DATABASE's transaction semantics, and the handler's
 * branching is covered in tests/. But unlike the line-delete proof it does NOT
 * hand-write the two statements either: it drives the REAL
 * `pgTransactionSupabase` shim, the REAL `buildGrnCancelReversals`, the REAL
 * `writeMovements` and the REAL `enqueueStockAllocationRecompute`, in the order
 * the handler runs them. So a change to the production enqueue — its columns,
 * its ON CONFLICT, its client contract — fails here.
 *
 * `scheduleStockAllocationAfterCommand` is deliberately not called: its
 * transactional half IS `enqueueStockAllocationRecompute`, and its other half
 * (the after-commit drain) runs only once the commit has already happened, so
 * it has nothing to do with this property.
 *
 * Runs against CI's postgres:16 service container (`backend-postgres` ->
 * `npm run test:pg`); SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

let sql: Sql;

const LINES = [
  {
    purchase_order_item_id: 'poi-a',
    qty_accepted: 2,
    item_code: 'MATT-A',
    material_name: 'Mattress A',
    item_group: 'MATTRESS',
    variants: null,
  },
];
const BATCHES = new Map([['poi-a', 'PO-2607-009']]);
const CTX = {
  warehouseId: 'wh-1', grnId: 'grn-1', grnNumber: 'GRN-2608-001', performedBy: 'user-1',
};

/** Exactly what the handler does inside runScmPgCommand, minus the guards. */
async function cancelInTransaction(
  tx: Sql,
  hooks: { beforeEnqueue?: () => Promise<void>; afterEnqueue?: () => Promise<void> } = {},
): Promise<void> {
  const sb = pgTransactionSupabase(tx);
  await sb.from('grns').update({ status: 'CANCELLED' }).eq('id', 'grn-1');
  const movements = buildGrnCancelReversals(LINES, BATCHES, CTX);
  await writeMovements(sb, movements, 1);
  if (hooks.beforeEnqueue) await hooks.beforeEnqueue();
  await enqueueStockAllocationRecompute(sb, `grn-cancel:${CTX.grnId}`);
  if (hooks.afterEnqueue) await hooks.afterEnqueue();
}

const statusOf = async () => {
  const rows = await sql`SELECT status FROM scm.grns WHERE id = 'grn-1'`;
  return rows[0]?.status as string | undefined;
};
const movementCount = async () => {
  const rows = await sql`SELECT count(*)::int AS n FROM scm.inventory_movements`;
  return rows[0]!.n as number;
};
const queueRows = async () => sql`SELECT job_key, reason FROM scm.stock_allocation_recompute_queue`;

describePg('a GRN cancel, its stock reversal and its allocation request are one unit', () => {
  beforeAll(async () => {
    // Same options production uses through Hyperdrive (src/db/pg.ts), so the
    // shim is exercised on the transaction pooler's no-prepare path.
    sql = postgres(url, { max: 1, prepare: false, fetch_types: false, onnotice: () => {} });
    await sql`CREATE SCHEMA IF NOT EXISTS scm`;
    /* The three tables this property needs, reduced to the columns it reads.
       Deliberately NOT the real migrations: the claim is about commit
       semantics, and a faithful 116-table replay would make the test slow and
       fragile without making it more true.

       DROP before CREATE, not `CREATE IF NOT EXISTS`: several files in this
       suite build tables of these same names with different column sets, and
       vitest's sequencer does not order files alphabetically. `IF NOT EXISTS`
       would silently inherit whichever shape ran first and fail on a column
       that is not there. */
    await sql`DROP TABLE IF EXISTS scm.grns`;
    await sql`DROP TABLE IF EXISTS scm.inventory_movements`;
    await sql`DROP TABLE IF EXISTS scm.stock_allocation_recompute_queue`;
    await sql`
      CREATE TABLE scm.grns (
        id text PRIMARY KEY,
        grn_number text,
        status text NOT NULL,
        warehouse_id text
      )`;
    await sql`
      CREATE TABLE scm.inventory_movements (
        id bigserial PRIMARY KEY,
        company_id bigint,
        movement_type text NOT NULL,
        warehouse_id text,
        item_code text,
        variant_key text,
        product_name text,
        qty numeric,
        batch_no text,
        movement_date date,
        source_doc_type text,
        source_doc_id text,
        source_doc_no text,
        performed_by text,
        notes text
      )`;
    await sql`
      CREATE TABLE scm.stock_allocation_recompute_queue (
        job_key text PRIMARY KEY,
        request_token text NOT NULL,
        requested_at timestamptz NOT NULL DEFAULT now(),
        reason text
      )`;
  });

  afterAll(async () => {
    await sql`DROP TABLE IF EXISTS scm.grns`;
    await sql`DROP TABLE IF EXISTS scm.inventory_movements`;
    await sql`DROP TABLE IF EXISTS scm.stock_allocation_recompute_queue`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`TRUNCATE scm.grns, scm.inventory_movements, scm.stock_allocation_recompute_queue`;
    await sql`
      INSERT INTO scm.grns (id, grn_number, status, warehouse_id)
      VALUES ('grn-1', 'GRN-2608-001', 'POSTED', 'wh-1')`;
  });

  test('COMMIT: cancelled AND reversed AND queued', async () => {
    await sql.begin((tx) => cancelInTransaction(tx as unknown as Sql));

    expect(await statusOf()).toBe('CANCELLED');
    expect(await movementCount()).toBe(1);
    const queue = await queueRows();
    expect(queue).toHaveLength(1);
    expect(queue[0]!.reason).toBe('grn-cancel:grn-1');
  });

  test('the reversing row is a real OUT carrying the line\'s own dye lot', async () => {
    /* Migration 0120. Asserted through the real shim because the batch is what
       makes the reversal deplete the lot the receipt created, and a shim that
       dropped the column would still commit "successfully". */
    await sql.begin((tx) => cancelInTransaction(tx as unknown as Sql));

    const rows = await sql`
      SELECT movement_type, item_code, qty, batch_no, source_doc_no, company_id
        FROM scm.inventory_movements`;
    expect(rows[0]).toMatchObject({
      movement_type: 'OUT',
      item_code: 'MATT-A',
      batch_no: 'PO-2607-009',
      source_doc_no: 'GRN-2608-001',
    });
    /* `numeric` and `bigint` come back from postgres.js as STRINGS — it will not
       silently narrow them through a float. So these two are compared as
       numbers, not asserted in the object literal above, where `company_id: 1`
       fails against '1'. (Caught by the first CI run of this file: there is no
       Postgres on the machine it was written on.) */
    expect(Number(rows[0]!.qty)).toBe(2);
    expect(Number(rows[0]!.company_id)).toBe(1);
  });

  test('ROLLBACK after the enqueue: NEITHER survives — the whole point', async () => {
    /* The failure mode this replaces: the flip and the OUT committed through
       PostgREST and the recompute was a separate best-effort call afterwards, so
       a crash in between left stock pulled back with no queue row and no retry.
       Inside one transaction that state is not reachable. */
    await expect(
      sql.begin((tx) => cancelInTransaction(tx as unknown as Sql, {
        afterEnqueue: async () => { throw new Error('worker died after the enqueue'); },
      })),
    ).rejects.toThrow('worker died after the enqueue');

    expect(await statusOf()).toBe('POSTED');
    expect(await movementCount()).toBe(0);
    expect(await queueRows()).toHaveLength(0);
  });

  test('a crash BEFORE the enqueue cannot leave the reversal behind either', async () => {
    /* The ordering inside the handler must not matter. If it did, "durable"
       would depend on where in the body the Worker happened to die. */
    await expect(
      sql.begin((tx) => cancelInTransaction(tx as unknown as Sql, {
        beforeEnqueue: async () => { throw new Error('worker died before the enqueue'); },
      })),
    ).rejects.toThrow('worker died before the enqueue');

    expect(await statusOf()).toBe('POSTED');
    expect(await movementCount()).toBe(0);
    expect(await queueRows()).toHaveLength(0);
  });

  test('a FAILED enqueue fails the cancel — it is not swallowed', async () => {
    /* This is the assertion the line-DELETE route shipped without, and it is
       why its enqueue sat inside a best-effort catch for a day while the comment
       beside it said the opposite (BUG-HISTORY 2026-08-20). "Stock pulled back,
       allocation never re-walked" must be UNREACHABLE, and a swallowed enqueue
       recreates it exactly.

       The queue table is renamed out from under the enqueue mid-transaction, so
       the real upsert really fails. Renaming inside the transaction also means
       the rollback puts it back. */
    await expect(
      sql.begin(async (tx) => {
        await cancelInTransaction(tx as unknown as Sql, {
          beforeEnqueue: async () => {
            await tx.unsafe('ALTER TABLE scm.stock_allocation_recompute_queue RENAME TO saq_hidden');
          },
        });
      }),
    ).rejects.toThrow();

    expect(await statusOf()).toBe('POSTED');
    expect(await movementCount()).toBe(0);
    const restored = await sql`SELECT to_regclass('scm.stock_allocation_recompute_queue') AS t`;
    expect(restored[0]!.t).not.toBeNull();
  });

  test('the queue is a SINGLETON: two cancels in one window leave one row', async () => {
    /* enqueueStockAllocationRecompute upserts on a fixed job_key, so a busy hour
       cannot grow the queue. Asserted here because the ON CONFLICT clause is the
       reason the drain can hold a single lease. */
    await sql`
      INSERT INTO scm.grns (id, grn_number, status, warehouse_id)
      VALUES ('grn-2', 'GRN-2608-002', 'POSTED', 'wh-1')`;
    for (const reason of ['grn-cancel:grn-1', 'grn-cancel:grn-2']) {
      await sql.begin(async (tx) => {
        await enqueueStockAllocationRecompute(pgTransactionSupabase(tx as unknown as Sql), reason);
      });
    }
    const queue = await queueRows();
    expect(queue).toHaveLength(1);
    expect(queue[0]!.reason).toBe('grn-cancel:grn-2');
  });
});
