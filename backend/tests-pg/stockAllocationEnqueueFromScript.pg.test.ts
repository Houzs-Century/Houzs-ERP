import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types; the SAME splitter pg-migrate.mjs
// uses, so the replay below is the real one and not a lookalike.
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';
// @ts-expect-error — plain .mjs helper, no types. THE module under test: the one
// every backend/scripts file that writes stock now calls.
import { enqueueStockAllocationRecompute } from '../scripts/lib/stock-allocation-enqueue.mjs';

/* scm.stock_allocation_recompute_queue, written by a SCRIPT, against a real server.
 *
 * WHAT THIS PROVES AND WHY IT NEEDS POSTGRES. `enqueueStockAllocationRecompute`
 * is one statement — an upsert on a singleton row that overwrites THREE columns
 * and deliberately leaves `attempts`, `deferrals` and `state` alone. Every
 * property that matters about it is a property of `ON CONFLICT DO UPDATE`:
 *
 *   · that a second request collapses onto the same row rather than inserting;
 *   · that the failure counter is NOT reset, so a permanently broken recompute
 *     can still reach its terminal DEAD state (the reason the TypeScript enqueue
 *     omits those columns, stated in its own header);
 *   · that a row already parked in DEAD stays DEAD — a script must not be able
 *     to launder a dead-lettered projection back into PENDING;
 *   · that the row it writes is exactly the row `drainStockAllocationRecompute`
 *     goes looking for, column for column.
 *
 * A stubbed client can assert none of those: it would be asserting its own
 * stub. tests/scriptStockWriteStaleProjection.test.ts proves the other half —
 * that a row of this shape makes the next cron sweep repair the projection.
 *
 * Runs against CI's postgres:16 service container (`backend-postgres` ->
 * `npm run test:pg`); SKIPPED, not failed, without TEST_DATABASE_URL.
 *
 * RE-RUN: this file is a test. It drops and recreates its own fixture schema on
 * every case and touches nothing outside `scm.stock_allocation_recompute_queue`
 * / `_lock` in the disposable houzs_test database.
 */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

// By SUFFIX, never by number — parallel PRs renumber migrations routinely, and a
// number-pinned read would silently resolve to nothing and pass vacuously.
async function migrationSql(): Promise<string> {
  const suffix = '_scm_stock_allocation_recompute_queue.sql';
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(suffix));
  if (files.length !== 1) {
    throw new Error(`expected exactly one *${suffix} migration, found ${files.length}: ${files.join(', ')}`);
  }
  return readFile(join(migrationsDir, files[0]!), 'utf8');
}

let admin: Sql;

async function reset(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') {
    throw new Error('PG integration tests require the disposable houzs_test database');
  }
  await sql.unsafe('DROP SCHEMA IF EXISTS scm CASCADE');
  await sql.unsafe('CREATE SCHEMA scm');
  // The migration GRANTs to service_role, which exists on Supabase and not in a
  // bare container. Create it rather than editing the migration out of the
  // replay: a replay that skips statements is not the migration.
  await sql.unsafe(`DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  const stmts = splitSqlStatements(await migrationSql()) as string[];
  await sql.begin(async (tx) => { for (const s of stmts) await tx.unsafe(s); });
}

describePg('a script queues the SO stock-allocation recompute', () => {
  beforeEach(async () => {
    admin ??= postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    await reset(admin);
  });

  afterAll(async () => { if (admin) await admin.end({ timeout: 5 }); });

  test('the first call INSERTs the singleton row the cron drains', async () => {
    const result = await enqueueStockAllocationRecompute(admin, 'reseed-stock-from-ac-snapshot');
    expect(result).toEqual({ queued: true, reason: 'reseed-stock-from-ac-snapshot', state: 'PENDING' });

    const rows = await admin`
      SELECT job_key, request_token, requested_at, reason, attempts, deferrals, state, next_attempt_at, locked_by
        FROM scm.stock_allocation_recompute_queue`;
    expect(rows).toHaveLength(1);
    // Column for column, this is what drainStockAllocationRecomputeWithClient
    // selects and branches on. A missing default here is a job that never runs.
    expect(rows[0]!.job_key).toBe('GLOBAL');
    expect(rows[0]!.reason).toBe('reseed-stock-from-ac-snapshot');
    expect(rows[0]!.attempts).toBe(0);
    expect(rows[0]!.deferrals).toBe(0);
    expect(rows[0]!.state).toBe('PENDING');
    expect(rows[0]!.next_attempt_at).toBeNull();
    expect(rows[0]!.locked_by).toBeNull();
    expect(rows[0]!.request_token).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('a SECOND call collapses onto the same row with a NEW token', async () => {
    await enqueueStockAllocationRecompute(admin, 'import-ac-stock-balance');
    const [first] = await admin`SELECT request_token, requested_at FROM scm.stock_allocation_recompute_queue`;

    await enqueueStockAllocationRecompute(admin, 'import-ac-sofa-stock');
    const rows = await admin`SELECT job_key, request_token, reason FROM scm.stock_allocation_recompute_queue`;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe('import-ac-sofa-stock');
    /* The token is the drain's generation fence: a request arriving mid-sweep
       must get a new one, or the running worker deletes work it never did. */
    expect(rows[0]!.request_token).not.toBe(first!.request_token);
  });

  test('the failure counter is NOT reset — a broken job can still reach DEAD', async () => {
    await enqueueStockAllocationRecompute(admin, 'first');
    await admin`UPDATE scm.stock_allocation_recompute_queue
                   SET attempts = 9, deferrals = 4, last_error = 'boom'
                 WHERE job_key = 'GLOBAL'`;

    await enqueueStockAllocationRecompute(admin, 'second');

    const [row] = await admin`SELECT attempts, deferrals, last_error FROM scm.stock_allocation_recompute_queue`;
    /* If the upsert listed `attempts` it would be 0 here, the tenth attempt
       would never arrive, and a permanently failing recompute would retry every
       five minutes forever with nobody told — the exact failure MAX_ATTEMPTS
       was added to end. */
    expect(row!.attempts).toBe(9);
    expect(row!.deferrals).toBe(4);
    expect(row!.last_error).toBe('boom');
  });

  test('a DEAD-lettered row stays DEAD, and the caller is told so', async () => {
    await enqueueStockAllocationRecompute(admin, 'first');
    await admin`UPDATE scm.stock_allocation_recompute_queue
                   SET state = 'DEAD', attempts = 10, dead_lettered_at = now()
                 WHERE job_key = 'GLOBAL'`;

    const result = await enqueueStockAllocationRecompute(admin, 'a script that moved stock');

    const [row] = await admin`SELECT state FROM scm.stock_allocation_recompute_queue`;
    expect(row!.state).toBe('DEAD');
    // The return value carries it out so the script can SAY it: a dead-lettered
    // queue means this request will never be drained, and a line reading
    // "recompute queued" would be a lie.
    expect(result.state).toBe('DEAD');
  });

  test('an unattributed request is refused before it reaches the database', async () => {
    await expect(enqueueStockAllocationRecompute(admin, '')).rejects.toThrow(/reason is required/);
    const rows = await admin`SELECT job_key FROM scm.stock_allocation_recompute_queue`;
    expect(rows).toHaveLength(0);
  });
});
