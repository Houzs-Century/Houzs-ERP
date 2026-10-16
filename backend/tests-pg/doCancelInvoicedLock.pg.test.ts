import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types; the SAME splitter pg-migrate.mjs uses.
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';

/* HC-0004 T2 — a delivery order a live Sales Invoice bills cannot be cancelled,
 * whether the SI names it on its header or only through its lines. SKIPPED
 * without TEST_DATABASE_URL (CI: backend-postgres -> npm run test:pg). */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const DB = 'hc0004_do_cancel_lock';
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

async function applyMigration(sql: Sql): Promise<void> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_scm_do_cancel_invoiced_lock.sql'));
  if (files.length !== 1) throw new Error(`expected one *_scm_do_cancel_invoiced_lock.sql, found ${files.length}`);
  const stmts = splitSqlStatements(await readFile(join(migrationsDir, files[0]!), 'utf8')) as string[];
  await sql.begin(async (tx) => { for (const s of stmts) await tx.unsafe(s); });
}

const FIXTURE = `
  DROP SCHEMA IF EXISTS scm CASCADE;
  CREATE SCHEMA scm;
  CREATE TYPE scm.do_status AS ENUM ('DRAFT','LOADED','DISPATCHED','IN_TRANSIT','SIGNED','DELIVERED','INVOICED','CANCELLED');
  CREATE TABLE scm.delivery_orders (id uuid PRIMARY KEY, status scm.do_status NOT NULL DEFAULT 'LOADED');
  CREATE TABLE scm.delivery_order_items (
    id uuid PRIMARY KEY,
    delivery_order_id uuid NOT NULL REFERENCES scm.delivery_orders(id) ON DELETE CASCADE
  );
  CREATE TABLE scm.sales_invoices (
    id uuid PRIMARY KEY,
    delivery_order_id uuid REFERENCES scm.delivery_orders(id),
    status text NOT NULL DEFAULT 'SENT'
  );
  CREATE TABLE scm.sales_invoice_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sales_invoice_id uuid NOT NULL REFERENCES scm.sales_invoices(id),
    do_item_id uuid REFERENCES scm.delivery_order_items(id) ON DELETE SET NULL
  );
`;

const DO_A = '00000000-0000-0000-0000-00000000000a';
const DO_B = '00000000-0000-0000-0000-00000000000b';
const DL_A = '00000000-0000-0000-0000-0000000000a1';
const DL_B = '00000000-0000-0000-0000-0000000000b1';
const SI = '00000000-0000-0000-0000-0000000000f1';

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

describePg('HC-0004 T2 — an invoiced DO cannot be cancelled', () => {
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
    await applyMigration(a);
    await a`INSERT INTO scm.delivery_orders (id) VALUES (${DO_A}), (${DO_B})`;
    await a`INSERT INTO scm.delivery_order_items (id, delivery_order_id) VALUES (${DL_A}, ${DO_A}), (${DL_B}, ${DO_B})`;
  });

  test('an SI built from 2 DOs: cancelling the second DO is refused; after the SI is cancelled it passes', async () => {
    // The header names only the FIRST DO, as si-from-do.ts writes it.
    await a`INSERT INTO scm.sales_invoices (id, delivery_order_id) VALUES (${SI}, ${DO_A})`;
    await a`INSERT INTO scm.sales_invoice_items (sales_invoice_id, do_item_id) VALUES (${SI}, ${DL_A}), (${SI}, ${DL_B})`;

    expect(await codeOf(a`UPDATE scm.delivery_orders SET status = 'CANCELLED' WHERE id = ${DO_B}`)).toBe('P0410');
    expect(await codeOf(a`UPDATE scm.delivery_orders SET status = 'CANCELLED' WHERE id = ${DO_A}`)).toBe('P0410');
    // Other status moves are untouched.
    expect(await codeOf(a`UPDATE scm.delivery_orders SET status = 'DELIVERED' WHERE id = ${DO_B}`)).toBeNull();

    await a`UPDATE scm.sales_invoices SET status = 'CANCELLED' WHERE id = ${SI}`;
    expect(await codeOf(a`UPDATE scm.delivery_orders SET status = 'CANCELLED' WHERE id = ${DO_B}`)).toBeNull();
  });

  test('an SI line inserted concurrently with the cancel: the cancel waits, then is refused', async () => {
    await a`INSERT INTO scm.sales_invoices (id, delivery_order_id) VALUES (${SI}, ${DO_A})`;

    let siInserted!: () => void;
    let commitSi!: () => void;
    const inserted = new Promise<void>((r) => { siInserted = r; });
    const release = new Promise<void>((r) => { commitSi = r; });
    const pSi = a.begin(async (tx) => {
      await tx`INSERT INTO scm.sales_invoice_items (sales_invoice_id, do_item_id) VALUES (${SI}, ${DL_B})`;
      siInserted();
      await release;
    });
    await inserted;
    const pCancel = codeOf(b`UPDATE scm.delivery_orders SET status = 'CANCELLED' WHERE id = ${DO_B}`.execute());

    let waiting = 0;
    for (let i = 0; i < 100 && waiting === 0; i++) {
      const [r] = await admin<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = ${DB} AND wait_event_type = 'Lock'`;
      waiting = r!.n;
      if (waiting === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(waiting).toBe(1);
    commitSi();

    await pSi;
    expect(await pCancel).toBe('P0410');
    const [d] = await a<Array<{ status: string }>>`SELECT status::text FROM scm.delivery_orders WHERE id = ${DO_B}`;
    expect(d!.status).toBe('LOADED');
  });
});
