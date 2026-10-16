import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types; the SAME splitter pg-migrate.mjs uses.
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';

/* HC-0004 T1 — the SO line -> DO line cap lives in the database.
 *
 * Proves, on a real postgres:16, that scm.assert_so_line_not_over_delivered:
 *   - lets exactly one of two concurrent inserts take the last unit;
 *   - refuses the second of two DRAFT DOs confirmed onto the same line;
 *   - lets an ALREADY-OVER line (prod has 8) take an unrelated edit, a qty cut
 *     and a cancel, and refuses only a write that adds to it.
 * SKIPPED without TEST_DATABASE_URL (CI: backend-postgres -> npm run test:pg). */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const DB = 'hc0004_so_do_guard';
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

async function applyMigration(sql: Sql): Promise<void> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_scm_so_line_over_delivery_guard.sql'));
  if (files.length !== 1) throw new Error(`expected one *_scm_so_line_over_delivery_guard.sql, found ${files.length}`);
  const stmts = splitSqlStatements(await readFile(join(migrationsDir, files[0]!), 'utf8')) as string[];
  await sql.begin(async (tx) => { for (const s of stmts) await tx.unsafe(s); });
}

/* Cut to the columns the guard reads; status is the real enum. */
const FIXTURE = `
  DROP SCHEMA IF EXISTS scm CASCADE;
  CREATE SCHEMA scm;
  CREATE TYPE scm.do_status AS ENUM ('DRAFT','LOADED','DISPATCHED','IN_TRANSIT','SIGNED','DELIVERED','INVOICED','CANCELLED');
  CREATE TABLE scm.mfg_sales_order_items (id uuid PRIMARY KEY, qty integer NOT NULL DEFAULT 1);
  CREATE TABLE scm.delivery_orders (
    id uuid PRIMARY KEY, do_number text NOT NULL,
    status scm.do_status NOT NULL DEFAULT 'LOADED', note text
  );
  CREATE TABLE scm.delivery_order_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_order_id uuid NOT NULL REFERENCES scm.delivery_orders(id) ON DELETE CASCADE,
    so_item_id uuid REFERENCES scm.mfg_sales_order_items(id) ON DELETE SET NULL,
    qty integer NOT NULL, note text
  );
  CREATE TABLE scm.delivery_returns (id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'PENDING');
  CREATE TABLE scm.delivery_return_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_return_id uuid NOT NULL, do_item_id uuid, qty_returned integer NOT NULL
  );
`;

const SO = '00000000-0000-0000-0000-0000000000a1';
const DO1 = '00000000-0000-0000-0000-0000000000d1';
const DO2 = '00000000-0000-0000-0000-0000000000d2';
const DO3 = '00000000-0000-0000-0000-0000000000d3';

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
  const [r] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM scm.delivery_order_items WHERE so_item_id = ${SO}`;
  return r!.n;
}

describePg('HC-0004 T1 — SO line over-delivery guard', () => {
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

  test('two connections insert the last unit at the same time: exactly one commits', async () => {
    await applyMigration(a);
    await a`INSERT INTO scm.mfg_sales_order_items (id, qty) VALUES (${SO}, 1)`;
    await a`INSERT INTO scm.delivery_orders (id, do_number) VALUES (${DO1}, 'DO-1'), (${DO2}, 'DO-2')`;

    let aInserted!: () => void;
    let releaseA!: () => void;
    const inserted = new Promise<void>((r) => { aInserted = r; });
    const release = new Promise<void>((r) => { releaseA = r; });

    const pA = a.begin(async (tx) => {
      await tx`INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id, qty) VALUES (${DO1}, ${SO}, 1)`;
      aInserted();
      await release;
    });
    await inserted;
    const pB = b.begin(async (tx) => {
      await tx`INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id, qty) VALUES (${DO2}, ${SO}, 1)`;
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
    expect((rb as PromiseRejectedResult).reason.code).toBe('P0409');
    expect(await lineCount(a)).toBe(1);
  });

  test('two DRAFT DOs on the same line both confirm: the second is refused', async () => {
    await applyMigration(a);
    await a`INSERT INTO scm.mfg_sales_order_items (id, qty) VALUES (${SO}, 1)`;
    await a`INSERT INTO scm.delivery_orders (id, do_number, status) VALUES (${DO1}, 'DO-1', 'DRAFT'), (${DO2}, 'DO-2', 'DRAFT')`;
    // Drafts do not count, so both lines go in.
    await a`INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id, qty) VALUES (${DO1}, ${SO}, 1), (${DO2}, ${SO}, 1)`;

    expect(await codeOf(a`UPDATE scm.delivery_orders SET status = 'LOADED' WHERE id = ${DO1}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.delivery_orders SET status = 'LOADED' WHERE id = ${DO2}`)).toBe('P0409');
    const [d2] = await a<Array<{ status: string }>>`SELECT status::text FROM scm.delivery_orders WHERE id = ${DO2}`;
    expect(d2!.status).toBe('DRAFT');
  });

  test('an already-over line takes an unrelated edit, a cut and a cancel; only an increase is refused', async () => {
    // Prod's shape: the line went over BEFORE the guard existed (qty 1, 3 live).
    await a`INSERT INTO scm.mfg_sales_order_items (id, qty) VALUES (${SO}, 1)`;
    await a`INSERT INTO scm.delivery_orders (id, do_number) VALUES (${DO1}, 'DO-1'), (${DO2}, 'DO-2'), (${DO3}, 'DO-3')`;
    await a`INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id, qty) VALUES (${DO1}, ${SO}, 2), (${DO2}, ${SO}, 1)`;
    await applyMigration(a);

    // Unrelated edits pass — including one whose SET list names qty unchanged,
    // which is how the DO line PATCH writes.
    expect(await codeOf(a`UPDATE scm.delivery_order_items SET note = 'x' WHERE delivery_order_id = ${DO1}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.delivery_order_items SET qty = qty, note = 'y' WHERE delivery_order_id = ${DO1}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.delivery_orders SET note = 'z', status = 'DISPATCHED' WHERE id = ${DO1}`)).toBeNull();

    // Increases are refused.
    expect(await codeOf(a`UPDATE scm.delivery_order_items SET qty = 3 WHERE delivery_order_id = ${DO1}`)).toBe('P0409');
    expect(await codeOf(a`INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id, qty) VALUES (${DO3}, ${SO}, 1)`)).toBe('P0409');

    // A cut and a cancel pass, even though the line is still over afterwards.
    expect(await codeOf(a`UPDATE scm.delivery_order_items SET qty = 1 WHERE delivery_order_id = ${DO1}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.delivery_orders SET status = 'CANCELLED' WHERE id = ${DO2}`)).toBeNull();

    // Un-cancelling adds DO-2's unit back past qty 1: refused.
    expect(await codeOf(a`UPDATE scm.delivery_orders SET status = 'LOADED' WHERE id = ${DO2}`)).toBe('P0409');
  });

  test('a live delivery return re-opens the line; a cancelled one does not', async () => {
    await applyMigration(a);
    await a`INSERT INTO scm.mfg_sales_order_items (id, qty) VALUES (${SO}, 1)`;
    await a`INSERT INTO scm.delivery_orders (id, do_number) VALUES (${DO1}, 'DO-1'), (${DO2}, 'DO-2')`;
    const [l] = await a<Array<{ id: string }>>`
      INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id, qty) VALUES (${DO1}, ${SO}, 1) RETURNING id`;
    const DR = '00000000-0000-0000-0000-0000000000e1';
    await a`INSERT INTO scm.delivery_returns (id, status) VALUES (${DR}, 'CANCELLED')`;
    await a`INSERT INTO scm.delivery_return_items (delivery_return_id, do_item_id, qty_returned) VALUES (${DR}, ${l!.id}, 1)`;
    expect(await codeOf(a`INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id, qty) VALUES (${DO2}, ${SO}, 1)`)).toBe('P0409');

    await a`UPDATE scm.delivery_returns SET status = 'COMPLETED' WHERE id = ${DR}`;
    expect(await codeOf(a`INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id, qty) VALUES (${DO2}, ${SO}, 1)`)).toBeNull();
  });
});
