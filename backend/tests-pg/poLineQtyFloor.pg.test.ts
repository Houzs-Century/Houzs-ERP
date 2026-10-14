import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types; the SAME splitter pg-migrate.mjs uses.
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';

/* HC-0004 — a PO line's qty cannot be cut below what live GRNs received.
 *
 * Proves, on a real postgres:16, with the PO -> GRN cap (20261014T1400) and the
 * floor (20261014T1430) both applied:
 *   - a cut below received is refused with P0411; a cut that stays at or above
 *     it passes; a cancelled GRN does not hold the floor up;
 *   - a GRN posted while an amendment cut is in flight: the cut waits on the row
 *     lock and is refused;
 *   - an ALREADY-OVER line (prod has 11) takes an unrelated edit and a raise.
 * SKIPPED without TEST_DATABASE_URL (CI: backend-postgres -> npm run test:pg). */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const DB = 'hc0004_po_qty_floor';
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

async function applyMigrations(sql: Sql): Promise<void> {
  for (const suffix of ['_scm_po_line_over_receipt_guard.sql', '_scm_po_line_qty_floor.sql']) {
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(suffix));
    if (files.length !== 1) throw new Error(`expected one *${suffix}, found ${files.length}`);
    const stmts = splitSqlStatements(await readFile(join(migrationsDir, files[0]!), 'utf8')) as string[];
    await sql.begin(async (tx) => { for (const s of stmts) await tx.unsafe(s); });
  }
}

/* Same cut as poLineOverReceiptGuard.pg.test.ts. */
const FIXTURE = `
  DROP SCHEMA IF EXISTS scm CASCADE;
  CREATE SCHEMA scm;
  CREATE TYPE scm.grn_status AS ENUM ('DRAFT','POSTED','CLOSED','CANCELLED','ON_HOLD');
  CREATE TABLE scm.purchase_order_items (id uuid PRIMARY KEY, qty integer NOT NULL DEFAULT 1, note text);
  CREATE TABLE scm.grns (
    id uuid PRIMARY KEY, grn_number text NOT NULL,
    status scm.grn_status NOT NULL DEFAULT 'POSTED', note text
  );
  CREATE TABLE scm.grn_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    grn_id uuid NOT NULL REFERENCES scm.grns(id) ON DELETE CASCADE,
    purchase_order_item_id uuid REFERENCES scm.purchase_order_items(id) ON DELETE SET NULL,
    qty_accepted integer NOT NULL, returned_qty integer NOT NULL DEFAULT 0, note text
  );
`;

const PO = '00000000-0000-0000-0000-0000000000a1';
const G1 = '00000000-0000-0000-0000-0000000000b1';
const G2 = '00000000-0000-0000-0000-0000000000b2';

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

async function poQty(): Promise<number> {
  const [r] = await a<Array<{ qty: number }>>`SELECT qty FROM scm.purchase_order_items WHERE id = ${PO}`;
  return r!.qty;
}

describePg('HC-0004 — PO line qty floor', () => {
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
    await applyMigrations(a);
    // qty 5, 3 received on GRN-1 (POSTED). GRN-2 is a DRAFT holding 2 more.
    await a`INSERT INTO scm.purchase_order_items (id, qty) VALUES (${PO}, 5)`;
    await a`INSERT INTO scm.grns (id, grn_number, status) VALUES (${G1}, 'GRN-1', 'POSTED'), (${G2}, 'GRN-2', 'DRAFT')`;
    await a`INSERT INTO scm.grn_items (grn_id, purchase_order_item_id, qty_accepted) VALUES (${G1}, ${PO}, 3), (${G2}, ${PO}, 2)`;
  });

  test('a cut below received is refused; a cut that stays at or above it passes', async () => {
    expect(await codeOf(a`UPDATE scm.purchase_order_items SET qty = 2 WHERE id = ${PO}`)).toBe('P0411');
    expect(await poQty()).toBe(5);
    expect(await codeOf(a`UPDATE scm.purchase_order_items SET qty = 4 WHERE id = ${PO}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.purchase_order_items SET qty = 3 WHERE id = ${PO}`)).toBeNull();
    expect(await poQty()).toBe(3);
  });

  test('a cancelled GRN does not hold the floor up', async () => {
    await a`UPDATE scm.grns SET status = 'CANCELLED' WHERE id = ${G1}`;
    expect(await codeOf(a`UPDATE scm.purchase_order_items SET qty = 1 WHERE id = ${PO}`)).toBeNull();
  });

  test('GRN posts first, amendment cuts second: the cut waits and is refused', async () => {
    let aDone!: () => void;
    let releaseA!: () => void;
    const done = new Promise<void>((r) => { aDone = r; });
    const release = new Promise<void>((r) => { releaseA = r; });
    const pA = a.begin(async (tx) => { await tx`UPDATE scm.grns SET status = 'POSTED' WHERE id = ${G2}`; aDone(); await release; });
    await done;
    // The app read 3 received and allows a cut to 4; GRN-2's 2 is not committed yet.
    const pB = b.begin(async (tx) => { await tx`UPDATE scm.purchase_order_items SET qty = 4 WHERE id = ${PO}`; });

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
    expect((rb as PromiseRejectedResult).reason.code).toBe('P0411');
    expect(await poQty()).toBe(5);
  });

  test('an already-over line takes an unrelated edit, a same-qty write and a raise', async () => {
    // Prod's shape: 6 received against qty 5, from before the guard.
    await a.unsafe('ALTER TABLE scm.grn_items DISABLE TRIGGER trg_grn_item_po_over_receipt');
    await a`INSERT INTO scm.grn_items (grn_id, purchase_order_item_id, qty_accepted) VALUES (${G1}, ${PO}, 3)`;
    await a.unsafe('ALTER TABLE scm.grn_items ENABLE TRIGGER trg_grn_item_po_over_receipt');

    expect(await codeOf(a`UPDATE scm.purchase_order_items SET note = 'x' WHERE id = ${PO}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.purchase_order_items SET qty = qty, note = 'y' WHERE id = ${PO}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.purchase_order_items SET qty = 7 WHERE id = ${PO}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.purchase_order_items SET qty = 5 WHERE id = ${PO}`)).toBe('P0411');
  });
});
