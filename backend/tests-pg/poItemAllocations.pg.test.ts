import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

/* END-TO-END PROOF of the consolidated-PO allocation invariants, against real
 * Postgres — the DDL half the unit suite (tests/poAllocations.test.ts) cannot
 * touch.
 *
 * The claim to settle: SUM(allocations.qty) <= line.qty is held by the DATABASE,
 * not only by the route's check-then-insert (which two concurrent writers can
 * both pass — the app writes go through PostgREST with no transaction around
 * the check + insert pair). So this suite drives the migration's two triggers
 * directly with SQL:
 *   · fn_po_item_alloc_guard  — an allocation INSERT/UPDATE past the line qty
 *     raises allocation_exceeds_line_qty;
 *   · fn_po_item_qty_guard    — a line-qty SHRINK below the allocated sum
 *     raises line_qty_below_allocated (any qty writer, amendments included).
 * Plus the FK semantics the module guide documents: line delete CASCADEs its
 * allocations; SO-line delete degrades a customer slice to STOCK (SET NULL);
 * and (item, seq) is UNIQUE so the printable sub-number cannot collide.
 *
 * Runs against CI's postgres:16 service container (`backend-postgres` ->
 * `npm run test:pg`); SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

// By SUFFIX, never by number — parallel PRs renumber migrations routinely, and a
// number-pinned read would silently resolve to nothing and pass vacuously.
async function allocationsMigrationSql(): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_scm_po_item_allocations.sql'));
  if (files.length !== 1) {
    throw new Error(
      `expected exactly one *_scm_po_item_allocations.sql migration, found ${files.length}: ${files.join(', ')}`,
    );
  }
  return (await readFile(join(migrationsDir, files[0]!), 'utf8')).replace(/\bproduct_code\b/g, 'item_code').replace(/\bmaterial_code\b/g, 'item_code');
}

const LINE = '11111111-1111-1111-1111-111111111111';
const LINE2 = '11111111-1111-1111-1111-222222222222';
const SO_A = '22222222-2222-2222-2222-222222222222';
const SO_B = '22222222-2222-2222-2222-333333333333';

let admin: Sql;

/* Only the referenced shapes, cut to the columns the migration touches. The
 * allocations table itself is deliberately NOT created here: the migration's
 * CREATE has to be what puts it there, so a broken file fails HERE rather than
 * in a deploy. */
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

    DROP TABLE IF EXISTS scm.purchase_order_item_allocations CASCADE;
    DROP TABLE IF EXISTS scm.purchase_order_items CASCADE;
    DROP TABLE IF EXISTS scm.mfg_sales_order_items CASCADE;
    DROP TABLE IF EXISTS public.companies CASCADE;

    CREATE TABLE public.companies (
      id bigint PRIMARY KEY,
      code text
    );
    INSERT INTO public.companies (id, code) VALUES (1, 'HOUZS');

    CREATE TABLE scm.purchase_order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      purchase_order_id uuid,
      item_code text,
      qty integer NOT NULL
    );

    CREATE TABLE scm.mfg_sales_order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      doc_no text,
      item_code text
    );

    INSERT INTO scm.purchase_order_items (id, item_code, qty) VALUES
      ('${LINE}',  'MAKOTO-Q', 5),
      ('${LINE2}', 'BF-15',    2);
    INSERT INTO scm.mfg_sales_order_items (id, doc_no, item_code) VALUES
      ('${SO_A}', '2990-SO-2606-036', 'MAKOTO-Q'),
      ('${SO_B}', '2990-SO-2606-029', 'MAKOTO-Q');
  `);

  await sql.unsafe(await allocationsMigrationSql());
}

const insertAlloc = (sql: Sql, line: string, seq: number, qty: number, so: string | null) =>
  sql`
    INSERT INTO scm.purchase_order_item_allocations
      (company_id, purchase_order_item_id, seq, qty, so_item_id)
    VALUES (1, ${line}::uuid, ${seq}, ${qty}, ${so}::uuid)
  `;

describePg('PO line allocations (mig *_scm_po_item_allocations) against real Postgres', () => {
  beforeAll(async () => {
    admin = postgres(url, { max: 4, onnotice: () => {} });
  });
  afterAll(async () => {
    await admin?.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await resetFixture(admin);
  });

  test('the migration is idempotent — applying it twice changes nothing and fails nothing', async () => {
    await admin.unsafe(await allocationsMigrationSql());
    const [{ n }] = await admin`
      SELECT COUNT(*)::int AS n FROM scm.purchase_order_item_allocations
    `;
    expect(n).toBe(0);
  });

  test("the owner's live case fits exactly: qty-5 line = SO-036 x1 + SO-029 x1 + stock x3", async () => {
    await insertAlloc(admin, LINE, 1, 1, SO_A);
    await insertAlloc(admin, LINE, 2, 1, SO_B);
    await insertAlloc(admin, LINE, 3, 3, null); // stock
    const rows = await admin`
      SELECT seq, qty, so_item_id FROM scm.purchase_order_item_allocations
       WHERE purchase_order_item_id = ${LINE}::uuid ORDER BY seq
    `;
    expect(rows.map((r) => [r.seq, r.qty, r.so_item_id])).toEqual([
      [1, 1, SO_A],
      [2, 1, SO_B],
      [3, 3, null],
    ]);
  });

  test('an INSERT past the line qty raises allocation_exceeds_line_qty', async () => {
    await insertAlloc(admin, LINE, 1, 3, SO_A);
    await expect(insertAlloc(admin, LINE, 2, 3, null))
      .rejects.toThrow(/allocation_exceeds_line_qty/);
    // The refused row must not exist — the guard fired BEFORE the write.
    const [{ n }] = await admin`
      SELECT COUNT(*)::int AS n FROM scm.purchase_order_item_allocations
       WHERE purchase_order_item_id = ${LINE}::uuid
    `;
    expect(n).toBe(1);
  });

  test('an UPDATE that grows a slice past the room the others leave raises too', async () => {
    await insertAlloc(admin, LINE, 1, 2, SO_A);
    await insertAlloc(admin, LINE, 2, 3, null); // exactly full: 2 + 3 = 5
    await expect(admin`
      UPDATE scm.purchase_order_item_allocations SET qty = 3
       WHERE purchase_order_item_id = ${LINE}::uuid AND seq = 1
    `).rejects.toThrow(/allocation_exceeds_line_qty/);
  });

  test('shrinking the LINE qty below the allocated sum raises line_qty_below_allocated; to exactly the sum passes', async () => {
    await insertAlloc(admin, LINE, 1, 2, SO_A);
    await insertAlloc(admin, LINE, 2, 2, null);
    await expect(admin`
      UPDATE scm.purchase_order_items SET qty = 3 WHERE id = ${LINE}::uuid
    `).rejects.toThrow(/line_qty_below_allocated/);
    // Shrinking to the exact allocated sum is legal — the invariant is <=.
    await admin`UPDATE scm.purchase_order_items SET qty = 4 WHERE id = ${LINE}::uuid`;
    const [{ qty }] = await admin`SELECT qty FROM scm.purchase_order_items WHERE id = ${LINE}::uuid`;
    expect(qty).toBe(4);
  });

  test('growing the line qty is never blocked (only a shrink can break the invariant)', async () => {
    await insertAlloc(admin, LINE, 1, 5, SO_A); // exactly full
    await admin`UPDATE scm.purchase_order_items SET qty = 9 WHERE id = ${LINE}::uuid`;
    const [{ qty }] = await admin`SELECT qty FROM scm.purchase_order_items WHERE id = ${LINE}::uuid`;
    expect(qty).toBe(9);
  });

  test('two concurrent writers cannot both land — the parent-line lock serialises them', async () => {
    // Both try to put 3 on a qty-5 line. Serialised by the FOR UPDATE on the
    // parent line, the second sees the first's 3 and must raise.
    const results = await Promise.allSettled([
      insertAlloc(admin, LINE, 1, 3, SO_A),
      insertAlloc(admin, LINE, 2, 3, null),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(String(failed[0]!.reason)).toMatch(/allocation_exceeds_line_qty/);
    const [{ total }] = await admin`
      SELECT COALESCE(SUM(qty), 0)::int AS total FROM scm.purchase_order_item_allocations
       WHERE purchase_order_item_id = ${LINE}::uuid
    `;
    expect(total).toBe(3); // never 6
  });

  test('deleting the PO line CASCADEs its allocations away', async () => {
    await insertAlloc(admin, LINE2, 1, 2, null);
    await admin`DELETE FROM scm.purchase_order_items WHERE id = ${LINE2}::uuid`;
    const [{ n }] = await admin`
      SELECT COUNT(*)::int AS n FROM scm.purchase_order_item_allocations
       WHERE purchase_order_item_id = ${LINE2}::uuid
    `;
    expect(n).toBe(0);
  });

  test('deleting the SO line degrades its slice to STOCK (SET NULL), the row survives', async () => {
    await insertAlloc(admin, LINE, 1, 2, SO_A);
    await admin`DELETE FROM scm.mfg_sales_order_items WHERE id = ${SO_A}::uuid`;
    const rows = await admin`
      SELECT qty, so_item_id FROM scm.purchase_order_item_allocations
       WHERE purchase_order_item_id = ${LINE}::uuid
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.so_item_id).toBeNull();
    expect(rows[0]!.qty).toBe(2);
  });

  test('the printable sub-number cannot collide: (item, seq) is UNIQUE', async () => {
    await insertAlloc(admin, LINE, 1, 1, SO_A);
    await expect(insertAlloc(admin, LINE, 1, 1, null)).rejects.toThrow(/po_item_alloc_seq_unique|duplicate key/);
  });

  test('qty and seq CHECKs hold at the column level too', async () => {
    await expect(insertAlloc(admin, LINE, 1, 0, null)).rejects.toThrow();
    await expect(insertAlloc(admin, LINE, 0, 1, null)).rejects.toThrow();
  });
});
