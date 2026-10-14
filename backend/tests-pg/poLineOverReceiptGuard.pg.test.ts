import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types; the SAME splitter pg-migrate.mjs uses.
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';

/* HC-0004 T3 — the PO line -> GRN line cap lives in the database.
 *
 * Proves, on a real postgres:16, that scm.assert_po_line_not_over_received:
 *   - lets exactly one of two concurrent inserts take the last units;
 *   - refuses the second of two DRAFT GRNs posted onto the same line;
 *   - lets an ALREADY-OVER line (prod has 11, +1 each, from the AutoCount
 *     import) take an unrelated edit, a cut, a cancel and a returned_qty
 *     rollup write, and refuses only a write that adds to it.
 * SKIPPED without TEST_DATABASE_URL (CI: backend-postgres -> npm run test:pg). */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const DB = 'hc0004_po_grn_guard';
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

async function applyMigration(sql: Sql): Promise<void> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_scm_po_line_over_receipt_guard.sql'));
  if (files.length !== 1) throw new Error(`expected one *_scm_po_line_over_receipt_guard.sql, found ${files.length}`);
  const stmts = splitSqlStatements(await readFile(join(migrationsDir, files[0]!), 'utf8')) as string[];
  await sql.begin(async (tx) => { for (const s of stmts) await tx.unsafe(s); });
}

/* Cut to the columns the guard reads; status is the real enum. */
const FIXTURE = `
  DROP SCHEMA IF EXISTS scm CASCADE;
  CREATE SCHEMA scm;
  CREATE TYPE scm.grn_status AS ENUM ('DRAFT','POSTED','CLOSED','CANCELLED','ON_HOLD');
  CREATE TABLE scm.purchase_order_items (id uuid PRIMARY KEY, qty integer NOT NULL DEFAULT 1);
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
const G3 = '00000000-0000-0000-0000-0000000000b3';

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

async function lineCount(sql: Sql): Promise<number> {
  const [r] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM scm.grn_items WHERE purchase_order_item_id = ${PO}`;
  return r!.n;
}

describePg('HC-0004 T3 — PO line over-receipt guard', () => {
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

  test('two connections receive the last units at the same time: exactly one commits', async () => {
    await applyMigration(a);
    await a`INSERT INTO scm.purchase_order_items (id, qty) VALUES (${PO}, 10)`;
    await a`INSERT INTO scm.grns (id, grn_number) VALUES (${G1}, 'GRN-1'), (${G2}, 'GRN-2')`;

    let aInserted!: () => void;
    let releaseA!: () => void;
    const inserted = new Promise<void>((r) => { aInserted = r; });
    const release = new Promise<void>((r) => { releaseA = r; });

    const pA = a.begin(async (tx) => {
      await tx`INSERT INTO scm.grn_items (grn_id, purchase_order_item_id, qty_accepted) VALUES (${G1}, ${PO}, 10)`;
      aInserted();
      await release;
    });
    await inserted;
    const pB = b.begin(async (tx) => {
      await tx`INSERT INTO scm.grn_items (grn_id, purchase_order_item_id, qty_accepted) VALUES (${G2}, ${PO}, 10)`;
    });

    // B must be WAITING on A's lock, not racing past it.
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
    expect(await lineCount(a)).toBe(1);
  });

  test('two DRAFT GRNs on the same line both post: the second is refused', async () => {
    await applyMigration(a);
    await a`INSERT INTO scm.purchase_order_items (id, qty) VALUES (${PO}, 1)`;
    await a`INSERT INTO scm.grns (id, grn_number, status) VALUES (${G1}, 'GRN-1', 'DRAFT'), (${G2}, 'GRN-2', 'DRAFT')`;
    // Drafts do not count, so both lines go in.
    await a`INSERT INTO scm.grn_items (grn_id, purchase_order_item_id, qty_accepted) VALUES (${G1}, ${PO}, 1), (${G2}, ${PO}, 1)`;

    expect(await codeOf(a`UPDATE scm.grns SET status = 'POSTED' WHERE id = ${G1}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.grns SET status = 'POSTED' WHERE id = ${G2}`)).toBe('P0411');
    const [g2] = await a<Array<{ status: string }>>`SELECT status::text FROM scm.grns WHERE id = ${G2}`;
    expect(g2!.status).toBe('DRAFT');
  });

  test('an already-over line takes an unrelated edit, a cut and a cancel; only an increase is refused', async () => {
    // Prod's shape: the line went over BEFORE the guard existed (qty 1, 2 live).
    await a`INSERT INTO scm.purchase_order_items (id, qty) VALUES (${PO}, 1)`;
    await a`INSERT INTO scm.grns (id, grn_number) VALUES (${G1}, 'GRN-1'), (${G2}, 'GRN-2'), (${G3}, 'GRN-3')`;
    await a`INSERT INTO scm.grn_items (grn_id, purchase_order_item_id, qty_accepted) VALUES (${G1}, ${PO}, 1), (${G2}, ${PO}, 1)`;
    await applyMigration(a);

    // Unrelated edits pass — including one whose SET list names qty unchanged,
    // which is how the GRN line PATCH writes — and a hold / release.
    expect(await codeOf(a`UPDATE scm.grn_items SET note = 'x' WHERE grn_id = ${G1}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.grn_items SET qty_accepted = qty_accepted, note = 'y' WHERE grn_id = ${G1}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.grns SET note = 'z', status = 'ON_HOLD' WHERE id = ${G1}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.grns SET status = 'POSTED' WHERE id = ${G1}`)).toBeNull();

    // Increases are refused.
    expect(await codeOf(a`UPDATE scm.grn_items SET qty_accepted = 2 WHERE grn_id = ${G1}`)).toBe('P0411');
    expect(await codeOf(a`INSERT INTO scm.grn_items (grn_id, purchase_order_item_id, qty_accepted) VALUES (${G3}, ${PO}, 1)`)).toBe('P0411');

    // The purchase-return rollup is never refused, either direction.
    expect(await codeOf(a`UPDATE scm.grn_items SET returned_qty = 1 WHERE grn_id = ${G2}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.grn_items SET returned_qty = 0 WHERE grn_id = ${G2}`)).toBeNull();

    // A cut and a cancel pass.
    expect(await codeOf(a`UPDATE scm.grn_items SET qty_accepted = 0 WHERE grn_id = ${G1}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.grn_items SET qty_accepted = 1 WHERE grn_id = ${G1}`)).toBe('P0411');
    expect(await codeOf(a`UPDATE scm.grns SET status = 'CANCELLED' WHERE id = ${G2}`)).toBeNull();
    // G1 is 0 and G2 cancelled: G1 can take its unit back.
    expect(await codeOf(a`UPDATE scm.grn_items SET qty_accepted = 1 WHERE grn_id = ${G1}`)).toBeNull();

    // Un-cancelling adds G2's unit back past qty 1: refused.
    expect(await codeOf(a`UPDATE scm.grns SET status = 'POSTED' WHERE id = ${G2}`)).toBe('P0411');
  });

  test('a purchase return on a line re-opens it for a replacement receipt', async () => {
    await applyMigration(a);
    await a`INSERT INTO scm.purchase_order_items (id, qty) VALUES (${PO}, 1)`;
    await a`INSERT INTO scm.grns (id, grn_number) VALUES (${G1}, 'GRN-1'), (${G2}, 'GRN-2')`;
    await a`INSERT INTO scm.grn_items (grn_id, purchase_order_item_id, qty_accepted) VALUES (${G1}, ${PO}, 1)`;
    expect(await codeOf(a`INSERT INTO scm.grn_items (grn_id, purchase_order_item_id, qty_accepted) VALUES (${G2}, ${PO}, 1)`)).toBe('P0411');

    await a`UPDATE scm.grn_items SET returned_qty = 1 WHERE grn_id = ${G1}`;
    expect(await codeOf(a`INSERT INTO scm.grn_items (grn_id, purchase_order_item_id, qty_accepted) VALUES (${G2}, ${PO}, 1)`)).toBeNull();
  });
});
