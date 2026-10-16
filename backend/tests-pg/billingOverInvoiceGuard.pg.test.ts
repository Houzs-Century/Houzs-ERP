import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types; the SAME splitter pg-migrate.mjs uses.
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';

/* HC-0004 T4 — the GRN line -> PI and DO line -> SI caps live in the database.
 *
 * Proves, on a real postgres:16, that the two guards:
 *   - let exactly one of two concurrent inserts take the last unit;
 *   - refuse the second of two DRAFT PIs confirmed onto the same GRN line;
 *   - let an ALREADY-OVER line take an unrelated edit, a cut and a cancel, and
 *     refuse only a write that adds to it (including an un-cancel / reopen);
 *   - count a live delivery return against what a DO line can still bill.
 * SKIPPED without TEST_DATABASE_URL (CI: backend-postgres -> npm run test:pg). */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const DB = 'hc0004_billing_guard';
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

async function applyMigration(sql: Sql): Promise<void> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_scm_billing_over_invoice_guard.sql'));
  if (files.length !== 1) throw new Error(`expected one *_scm_billing_over_invoice_guard.sql, found ${files.length}`);
  const stmts = splitSqlStatements(await readFile(join(migrationsDir, files[0]!), 'utf8')) as string[];
  await sql.begin(async (tx) => { for (const s of stmts) await tx.unsafe(s); });
}

/* Cut to the columns the guards read; statuses are the real enums. */
const FIXTURE = `
  DROP SCHEMA IF EXISTS scm CASCADE;
  CREATE SCHEMA scm;
  CREATE TYPE scm.purchase_invoice_status AS ENUM ('DRAFT','POSTED','PARTIALLY_PAID','PAID','CANCELLED','VOID');
  CREATE TYPE scm.sales_invoice_status AS ENUM ('DRAFT','SENT','PARTIALLY_PAID','PAID','CANCELLED','VOID');
  CREATE TABLE scm.grn_items (id uuid PRIMARY KEY, qty_accepted integer NOT NULL, returned_qty integer NOT NULL DEFAULT 0);
  CREATE TABLE scm.purchase_invoices (id uuid PRIMARY KEY, status scm.purchase_invoice_status NOT NULL DEFAULT 'POSTED', note text);
  CREATE TABLE scm.purchase_invoice_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_invoice_id uuid NOT NULL REFERENCES scm.purchase_invoices(id) ON DELETE CASCADE,
    grn_item_id uuid REFERENCES scm.grn_items(id) ON DELETE SET NULL,
    qty integer NOT NULL, note text
  );
  CREATE TABLE scm.delivery_order_items (id uuid PRIMARY KEY, qty integer NOT NULL);
  CREATE TABLE scm.delivery_returns (id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'PENDING');
  CREATE TABLE scm.delivery_return_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_return_id uuid NOT NULL, do_item_id uuid, qty_returned integer NOT NULL
  );
  CREATE TABLE scm.sales_invoices (id uuid PRIMARY KEY, status scm.sales_invoice_status NOT NULL DEFAULT 'DRAFT', note text);
  CREATE TABLE scm.sales_invoice_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sales_invoice_id uuid NOT NULL REFERENCES scm.sales_invoices(id) ON DELETE CASCADE,
    do_item_id uuid REFERENCES scm.delivery_order_items(id) ON DELETE SET NULL,
    qty integer NOT NULL, note text
  );
`;

const GI = '00000000-0000-0000-0000-0000000000a1';
const DI = '00000000-0000-0000-0000-0000000000a2';
const P1 = '00000000-0000-0000-0000-0000000000b1';
const P2 = '00000000-0000-0000-0000-0000000000b2';
const P3 = '00000000-0000-0000-0000-0000000000b3';
const S1 = '00000000-0000-0000-0000-0000000000c1';
const S2 = '00000000-0000-0000-0000-0000000000c2';
const S3 = '00000000-0000-0000-0000-0000000000c3';

let admin: Sql;
let a: Sql;
let b: Sql;

function urlFor(db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try { await p; return null; } catch (e) { return (e as { code?: string }).code ?? 'unknown'; }
}

/* A holds the first insert open; B's insert must wait on A's row lock, then
   lose with `code`. Returns the number of committed lines. */
async function raceTwoInserts(first: (tx: Sql) => Promise<unknown>, second: (tx: Sql) => Promise<unknown>, code: string, count: () => Promise<number>): Promise<number> {
  let aInserted!: () => void;
  let releaseA!: () => void;
  const inserted = new Promise<void>((r) => { aInserted = r; });
  const release = new Promise<void>((r) => { releaseA = r; });

  const pA = a.begin(async (tx) => { await first(tx as unknown as Sql); aInserted(); await release; });
  await inserted;
  const pB = b.begin(async (tx) => { await second(tx as unknown as Sql); });

  let waiting = 0;
  for (let i = 0; i < 100 && waiting === 0; i++) {
    const [r] = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = ${DB} AND wait_event_type = 'Lock'`;
    waiting = r!.n;
    if (waiting === 0) await new Promise((r) => setTimeout(r, 50));
  }
  expect(waiting).toBe(1);
  releaseA();

  const [ra, rb] = await Promise.allSettled([pA, pB]);
  expect(ra.status).toBe('fulfilled');
  expect(rb.status).toBe('rejected');
  expect((rb as PromiseRejectedResult).reason.code).toBe(code);
  return count();
}

describePg('HC-0004 T4 — GRN -> PI and DO -> SI over-invoice guards', () => {
  beforeAll(async () => {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') throw new Error('refusing a non-local TEST_DATABASE_URL');
    admin = postgres(url, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${DB}`);
    // prepare: false — each test drops and rebuilds the schema under the same names.
    a = postgres(urlFor(DB), { max: 1, prepare: false });
    b = postgres(urlFor(DB), { max: 1, prepare: false });
  });

  afterAll(async () => {
    await a?.end();
    await b?.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await a.unsafe(FIXTURE);
  });

  test('GRN -> PI: two concurrent bills of the last unit, exactly one commits', async () => {
    await applyMigration(a);
    await a`INSERT INTO scm.grn_items (id, qty_accepted) VALUES (${GI}, 1)`;
    await a`INSERT INTO scm.purchase_invoices (id) VALUES (${P1}), (${P2})`;
    const n = await raceTwoInserts(
      (tx) => tx`INSERT INTO scm.purchase_invoice_items (purchase_invoice_id, grn_item_id, qty) VALUES (${P1}, ${GI}, 1)`,
      (tx) => tx`INSERT INTO scm.purchase_invoice_items (purchase_invoice_id, grn_item_id, qty) VALUES (${P2}, ${GI}, 1)`,
      'P0412',
      async () => (await a<Array<{ n: number }>>`SELECT count(*)::int AS n FROM scm.purchase_invoice_items`)[0]!.n,
    );
    expect(n).toBe(1);
  });

  test('DO -> SI: two concurrent bills of the last unit, exactly one commits', async () => {
    await applyMigration(a);
    await a`INSERT INTO scm.delivery_order_items (id, qty) VALUES (${DI}, 1)`;
    await a`INSERT INTO scm.sales_invoices (id) VALUES (${S1}), (${S2})`;
    const n = await raceTwoInserts(
      (tx) => tx`INSERT INTO scm.sales_invoice_items (sales_invoice_id, do_item_id, qty) VALUES (${S1}, ${DI}, 1)`,
      (tx) => tx`INSERT INTO scm.sales_invoice_items (sales_invoice_id, do_item_id, qty) VALUES (${S2}, ${DI}, 1)`,
      'P0413',
      async () => (await a<Array<{ n: number }>>`SELECT count(*)::int AS n FROM scm.sales_invoice_items`)[0]!.n,
    );
    expect(n).toBe(1);
  });

  test('GRN -> PI: two DRAFT PIs on one line both confirm, the second is refused', async () => {
    await applyMigration(a);
    await a`INSERT INTO scm.grn_items (id, qty_accepted) VALUES (${GI}, 1)`;
    await a`INSERT INTO scm.purchase_invoices (id, status) VALUES (${P1}, 'DRAFT'), (${P2}, 'DRAFT')`;
    await a`INSERT INTO scm.purchase_invoice_items (purchase_invoice_id, grn_item_id, qty) VALUES (${P1}, ${GI}, 1), (${P2}, ${GI}, 1)`;

    expect(await codeOf(a`UPDATE scm.purchase_invoices SET status = 'POSTED' WHERE id = ${P1}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.purchase_invoices SET status = 'POSTED' WHERE id = ${P2}`)).toBe('P0412');
    const [p2] = await a<Array<{ status: string }>>`SELECT status::text FROM scm.purchase_invoices WHERE id = ${P2}`;
    expect(p2!.status).toBe('DRAFT');
  });

  test('GRN -> PI: an already-over line takes an unrelated edit, a cut and a cancel; only an increase is refused', async () => {
    await a`INSERT INTO scm.grn_items (id, qty_accepted) VALUES (${GI}, 1)`;
    await a`INSERT INTO scm.purchase_invoices (id) VALUES (${P1}), (${P2}), (${P3})`;
    await a`INSERT INTO scm.purchase_invoice_items (purchase_invoice_id, grn_item_id, qty) VALUES (${P1}, ${GI}, 2), (${P2}, ${GI}, 1)`;
    await applyMigration(a);

    expect(await codeOf(a`UPDATE scm.purchase_invoice_items SET note = 'x' WHERE purchase_invoice_id = ${P1}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.purchase_invoice_items SET qty = qty, note = 'y' WHERE purchase_invoice_id = ${P1}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.purchase_invoices SET note = 'z', status = 'PAID' WHERE id = ${P1}`)).toBeNull();

    expect(await codeOf(a`UPDATE scm.purchase_invoice_items SET qty = 3 WHERE purchase_invoice_id = ${P1}`)).toBe('P0412');
    expect(await codeOf(a`INSERT INTO scm.purchase_invoice_items (purchase_invoice_id, grn_item_id, qty) VALUES (${P3}, ${GI}, 1)`)).toBe('P0412');

    expect(await codeOf(a`UPDATE scm.purchase_invoice_items SET qty = 1 WHERE purchase_invoice_id = ${P1}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.purchase_invoices SET status = 'CANCELLED' WHERE id = ${P2}`)).toBeNull();
    // P2 un-cancelled would bill past qty_accepted 1 again: refused.
    expect(await codeOf(a`UPDATE scm.purchase_invoices SET status = 'POSTED' WHERE id = ${P2}`)).toBe('P0412');
  });

  test('DO -> SI: an already-over line takes an unrelated edit, a cut and a cancel; a raise and a reopen are refused', async () => {
    await a`INSERT INTO scm.delivery_order_items (id, qty) VALUES (${DI}, 1)`;
    await a`INSERT INTO scm.sales_invoices (id, status) VALUES (${S1}, 'SENT'), (${S2}, 'SENT'), (${S3}, 'DRAFT')`;
    await a`INSERT INTO scm.sales_invoice_items (sales_invoice_id, do_item_id, qty) VALUES (${S1}, ${DI}, 2), (${S2}, ${DI}, 1)`;
    await applyMigration(a);

    expect(await codeOf(a`UPDATE scm.sales_invoice_items SET note = 'x' WHERE sales_invoice_id = ${S1}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.sales_invoice_items SET qty = qty, note = 'y' WHERE sales_invoice_id = ${S1}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.sales_invoices SET note = 'z', status = 'PAID' WHERE id = ${S1}`)).toBeNull();

    expect(await codeOf(a`UPDATE scm.sales_invoice_items SET qty = 3 WHERE sales_invoice_id = ${S1}`)).toBe('P0413');
    // A DRAFT SI counts on the sales side, so even a draft line is refused.
    expect(await codeOf(a`INSERT INTO scm.sales_invoice_items (sales_invoice_id, do_item_id, qty) VALUES (${S3}, ${DI}, 1)`)).toBe('P0413');

    expect(await codeOf(a`UPDATE scm.sales_invoice_items SET qty = 1 WHERE sales_invoice_id = ${S1}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.sales_invoices SET status = 'CANCELLED' WHERE id = ${S2}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.sales_invoices SET status = 'SENT' WHERE id = ${S2}`)).toBe('P0413');
  });

  test('DO -> SI: a live delivery return lowers what the line can bill; a cancelled one does not', async () => {
    await applyMigration(a);
    await a`INSERT INTO scm.delivery_order_items (id, qty) VALUES (${DI}, 2)`;
    await a`INSERT INTO scm.sales_invoices (id) VALUES (${S1})`;
    const DR = '00000000-0000-0000-0000-0000000000e1';
    await a`INSERT INTO scm.delivery_returns (id, status) VALUES (${DR}, 'COMPLETED')`;
    await a`INSERT INTO scm.delivery_return_items (delivery_return_id, do_item_id, qty_returned) VALUES (${DR}, ${DI}, 1)`;
    expect(await codeOf(a`INSERT INTO scm.sales_invoice_items (sales_invoice_id, do_item_id, qty) VALUES (${S1}, ${DI}, 2)`)).toBe('P0413');

    await a`UPDATE scm.delivery_returns SET status = 'CANCELLED' WHERE id = ${DR}`;
    expect(await codeOf(a`INSERT INTO scm.sales_invoice_items (sales_invoice_id, do_item_id, qty) VALUES (${S1}, ${DI}, 2)`)).toBeNull();
  });
});
