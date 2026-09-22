import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';
import { assertDisposableTestDatabase } from './lib/doc-no-fixture';

/* REGRESSION PROOF for the manual (PO-less) Goods Receipt.
 *
 * A GRN created WITHOUT a parent PO — a repair charge, a one-off fee, a
 * freight-only receipt — writes scm.grns.purchase_order_id = NULL (the New GRN
 * form does this on purpose; the create route inserts `purchaseOrderId ?? null`).
 * The column shipped NOT NULL, so every one of those receipts failed at the
 * header insert with "null value in column purchase_order_id violates not-null
 * constraint" — surfaced to the operator only as the generic "The system hit a
 * problem." Proof it never once worked: of 687 production GRNs, ZERO had a null
 * purchase_order_id. The migration under test drops that NOT NULL.
 *
 * Asserted against real Postgres because the claim is a schema property. The
 * migration file is located by SUFFIX, never by number — parallel PRs renumber
 * migrations routinely, and a number-pinned read would resolve to nothing and
 * pass vacuously. Runs against CI's postgres:16 (`npm run test:pg`); SKIPPED,
 * not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

/** Apply the real migration file exactly as pg-migrate.mjs does: split, then one
    transaction. Returns the statement count so the caller can assert it was real. */
async function applyPoNullableMigration(sql: Sql): Promise<number> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_grns_purchase_order_id_nullable.sql'));
  if (files.length !== 1) {
    throw new Error(
      `expected exactly one *_grns_purchase_order_id_nullable.sql migration, found ${files.length}: ${files.join(', ')}`,
    );
  }
  const stmts = splitSqlStatements(await readFile(join(migrationsDir, files[0]!), 'utf8')) as string[];
  await sql.begin(async (tx) => { for (const s of stmts) await tx.unsafe(s); });
  return stmts.length;
}

let sql: Sql;

const isNullable = async (): Promise<string | undefined> => {
  const rows = await sql`
    SELECT is_nullable FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = 'grns' AND column_name = 'purchase_order_id'`;
  return rows[0]?.is_nullable as string | undefined;
};

/** A hand-added receipt: supplier + lines but no parent PO, so the header PO ref
    is NULL. This is exactly what POST /api/scm/grns writes for a manual GRN. */
const insertPoLessHeader = () => sql`
  INSERT INTO scm.grns (id, grn_number, supplier_id, status, purchase_order_id)
  VALUES ('grn-manual-1', 'HC-GR-999001', 'sup-1', 'POSTED', NULL)`;

describePg('scm.grns.purchase_order_id is nullable so a manual (PO-less) receipt saves', () => {
  beforeAll(async () => {
    assertDisposableTestDatabase(url);
    // Same options production uses through Hyperdrive (src/db/pg.ts).
    sql = postgres(url, { max: 1, prepare: false, fetch_types: false, onnotice: () => {} });
    await sql`CREATE SCHEMA IF NOT EXISTS scm`;
    await sql`DROP TABLE IF EXISTS scm.grns`;
    /* The header reduced to the columns this property needs, in the PRE-FIX
       production shape: purchase_order_id NOT NULL. The migration under test is
       the only thing that makes the NULL insert below succeed. */
    await sql`
      CREATE TABLE scm.grns (
        id text PRIMARY KEY,
        grn_number text NOT NULL,
        supplier_id text NOT NULL,
        status text NOT NULL,
        purchase_order_id text NOT NULL
      )`;
  });

  afterAll(async () => {
    await sql`DROP TABLE IF EXISTS scm.grns`;
    await sql.end({ timeout: 5 });
  });

  test('the real migration flips the column to nullable, unblocking the header insert', async () => {
    // BEFORE — the pre-fix world refuses a PO-less header. This is the bug.
    expect(await isNullable()).toBe('NO');
    await expect(insertPoLessHeader()).rejects.toThrow(/not-null|null value/i);

    // Apply the actual shipped migration (added by #4222).
    expect(await applyPoNullableMigration(sql)).toBeGreaterThanOrEqual(1);

    // AFTER — the column is nullable and the manual receipt inserts with NULL.
    expect(await isNullable()).toBe('YES');
    await insertPoLessHeader();
    const rows = await sql`SELECT purchase_order_id FROM scm.grns WHERE id = 'grn-manual-1'`;
    expect(rows[0]!.purchase_order_id).toBeNull();
  });
});
