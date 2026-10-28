import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

/* END-TO-END PROOF that a GRN line delete and its allocation-recompute request
 * COMMIT TOGETHER OR NOT AT ALL — against real Postgres, because that property
 * is a transaction property and no unit test can observe it.
 *
 * WHY IT MATTERS, in one sentence: without it, a Worker that dies between the
 * stock reversal and the recompute leaves stock moved and SO lines still marked
 * READY, silently, until some unrelated mutation happens to sweep. That is the
 * gap docs/ALLOCATION-DURABILITY-PLAN.md exists to close, and `DELETE
 * /grns/:id/items/:itemId` is the first route through it.
 *
 * WHAT IS AND IS NOT SIMULATED. This drives SQL directly rather than booting the
 * route: the claim under test is about the DATABASE's transaction semantics
 * (does the queue row survive a rollback?), not about the handler's branching,
 * which tests/ already covers. So the test writes the same two statements the
 * handler writes, inside one transaction, and then kills it.
 *
 * Runs against CI's postgres:16 service container (`backend-postgres` ->
 * `npm run test:pg`); SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

let sql: Sql;

describePg('a GRN line delete and its allocation request are one unit', () => {
  beforeAll(async () => {
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`CREATE SCHEMA IF NOT EXISTS scm`;
    /* The two tables the handler touches, reduced to the columns this property
       needs. Deliberately NOT the real migrations: the claim is about commit
       semantics, and a faithful 116-table replay would make the test slow and
       fragile without making it more true. */
    await sql`
      CREATE TABLE IF NOT EXISTS scm.grn_items (
        id text PRIMARY KEY,
        grn_id text NOT NULL,
        qty_accepted numeric NOT NULL DEFAULT 0
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS scm.stock_allocation_recompute_queue (
        job_key text PRIMARY KEY,
        request_token text NOT NULL,
        requested_at timestamptz NOT NULL DEFAULT now(),
        reason text
      )`;
  });

  afterAll(async () => {
    await sql`DROP TABLE IF EXISTS scm.grn_items`;
    await sql`DROP TABLE IF EXISTS scm.stock_allocation_recompute_queue`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`TRUNCATE scm.grn_items, scm.stock_allocation_recompute_queue`;
    await sql`INSERT INTO scm.grn_items (id, grn_id, qty_accepted) VALUES ('line-1', 'grn-1', 3)`;
  });

  test('COMMIT: the line is gone AND the recompute is queued', async () => {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM scm.grn_items WHERE id = 'line-1'`;
      await tx`
        INSERT INTO scm.stock_allocation_recompute_queue (job_key, request_token, reason)
        VALUES ('GLOBAL', 'tok-1', 'grn-line-delete:grn-1')
        ON CONFLICT (job_key) DO UPDATE SET request_token = EXCLUDED.request_token,
                                            reason = EXCLUDED.reason`;
    });

    const lines = await sql`SELECT id FROM scm.grn_items WHERE id = 'line-1'`;
    const queue = await sql`SELECT reason FROM scm.stock_allocation_recompute_queue WHERE job_key = 'GLOBAL'`;
    expect(lines).toHaveLength(0);
    expect(queue).toHaveLength(1);
    expect(queue[0].reason).toBe('grn-line-delete:grn-1');
  });

  test('ROLLBACK: NEITHER survives — the whole point', async () => {
    /* The failure mode this replaces: the delete committed through PostgREST and
       the recompute was a separate best-effort call afterwards, so a crash in
       between left stock moved with no queue row and no retry. Inside one
       transaction that state is not reachable. */
    await expect(
      sql.begin(async (tx) => {
        await tx`DELETE FROM scm.grn_items WHERE id = 'line-1'`;
        await tx`
          INSERT INTO scm.stock_allocation_recompute_queue (job_key, request_token, reason)
          VALUES ('GLOBAL', 'tok-2', 'grn-line-delete:grn-1')`;
        throw new Error('worker died after the enqueue');
      }),
    ).rejects.toThrow('worker died after the enqueue');

    const lines = await sql`SELECT id FROM scm.grn_items WHERE id = 'line-1'`;
    const queue = await sql`SELECT job_key FROM scm.stock_allocation_recompute_queue`;
    expect(lines).toHaveLength(1);   // the line is STILL THERE
    expect(queue).toHaveLength(0);   // and nothing was queued
  });

  test('a crash BEFORE the enqueue cannot leave the delete behind either', async () => {
    /* The ordering inside the handler must not matter. If it did, "durable"
       would depend on where in the body the Worker happened to die. */
    await expect(
      sql.begin(async (tx) => {
        await tx`DELETE FROM scm.grn_items WHERE id = 'line-1'`;
        throw new Error('worker died before the enqueue');
      }),
    ).rejects.toThrow('worker died before the enqueue');

    const lines = await sql`SELECT id FROM scm.grn_items WHERE id = 'line-1'`;
    expect(lines).toHaveLength(1);
  });

  test('the queue is a SINGLETON: two deletes in one window leave one row', async () => {
    /* enqueueStockAllocationRecompute upserts on a fixed job_key, so a busy hour
       cannot grow the queue. Asserted here because the ON CONFLICT clause is the
       reason the drain can hold a single lease. */
    await sql`INSERT INTO scm.grn_items (id, grn_id, qty_accepted) VALUES ('line-2', 'grn-1', 1)`;
    for (const [id, tok] of [['line-1', 'tok-a'], ['line-2', 'tok-b']] as const) {
      await sql.begin(async (tx) => {
        await tx`DELETE FROM scm.grn_items WHERE id = ${id}`;
        await tx`
          INSERT INTO scm.stock_allocation_recompute_queue (job_key, request_token, reason)
          VALUES ('GLOBAL', ${tok}, 'grn-line-delete:grn-1')
          ON CONFLICT (job_key) DO UPDATE SET request_token = EXCLUDED.request_token`;
      });
    }
    const queue = await sql`SELECT request_token FROM scm.stock_allocation_recompute_queue`;
    expect(queue).toHaveLength(1);
    expect(queue[0].request_token).toBe('tok-b');
  });
});
