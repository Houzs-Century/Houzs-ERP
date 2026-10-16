import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types; the SAME splitter pg-migrate.mjs uses.
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';

/* HC-0004 T6 — an SO line's qty cannot be cut below what live DOs ship.
 *
 * Proves, on a real postgres:16, with the SO -> DO cap (20261014T1300) and the
 * floor (20261014T1420) both applied:
 *   - an amendment cut and a DO insert racing on one SO line: whichever writes
 *     second waits on the row lock and is refused with P0409, in either order;
 *   - an ALREADY-OVER line (prod has 8) takes an unrelated edit, a same-qty
 *     write and a raise; only a cut is checked.
 * SKIPPED without TEST_DATABASE_URL (CI: backend-postgres -> npm run test:pg). */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const DB = 'hc0004_so_qty_floor';
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

async function applyMigrations(sql: Sql): Promise<void> {
  for (const suffix of ['_scm_so_line_over_delivery_guard.sql', '_scm_so_line_qty_floor.sql']) {
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(suffix));
    if (files.length !== 1) throw new Error(`expected one *${suffix}, found ${files.length}`);
    const stmts = splitSqlStatements(await readFile(join(migrationsDir, files[0]!), 'utf8')) as string[];
    await sql.begin(async (tx) => { for (const s of stmts) await tx.unsafe(s); });
  }
}

/* Same cut as soLineOverDeliveryGuard.pg.test.ts. */
const FIXTURE = `
  DROP SCHEMA IF EXISTS scm CASCADE;
  CREATE SCHEMA scm;
  CREATE TYPE scm.do_status AS ENUM ('DRAFT','LOADED','DISPATCHED','IN_TRANSIT','SIGNED','DELIVERED','INVOICED','CANCELLED');
  CREATE TABLE scm.mfg_sales_order_items (id uuid PRIMARY KEY, qty integer NOT NULL DEFAULT 1, note text);
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

/* `first` runs on A and holds its transaction open; `second` runs on B and must
   wait on A's lock. Returns both outcomes once A commits. */
async function race(first: (tx: Sql) => Promise<unknown>, second: (tx: Sql) => Promise<unknown>) {
  let aDone!: () => void;
  let releaseA!: () => void;
  const done = new Promise<void>((r) => { aDone = r; });
  const release = new Promise<void>((r) => { releaseA = r; });
  const pA = a.begin(async (tx) => { await first(tx as unknown as Sql); aDone(); await release; });
  await done;
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
  return Promise.allSettled([pA, pB]);
}

async function soQty(): Promise<number> {
  const [r] = await a<Array<{ qty: number }>>`SELECT qty FROM scm.mfg_sales_order_items WHERE id = ${SO}`;
  return r!.qty;
}

async function delivered(): Promise<number> {
  const [r] = await a<Array<{ n: number }>>`SELECT coalesce(sum(qty), 0)::int AS n FROM scm.delivery_order_items WHERE so_item_id = ${SO}`;
  return r!.n;
}

describePg('HC-0004 T6 — SO line qty floor', () => {
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
    // qty 2, 1 already shipped on DO-1; DO-2 is about to ship the second unit.
    await a`INSERT INTO scm.mfg_sales_order_items (id, qty) VALUES (${SO}, 2)`;
    await a`INSERT INTO scm.delivery_orders (id, do_number) VALUES (${DO1}, 'DO-1'), (${DO2}, 'DO-2')`;
    await a`INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id, qty) VALUES (${DO1}, ${SO}, 1)`;
  });

  test('amendment cuts first, DO ships second: the DO waits and is refused', async () => {
    const [ra, rb] = await race(
      (tx) => tx`UPDATE scm.mfg_sales_order_items SET qty = 1 WHERE id = ${SO}`,
      (tx) => tx`INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id, qty) VALUES (${DO2}, ${SO}, 1)`,
    );
    expect(ra.status).toBe('fulfilled');
    expect(rb.status).toBe('rejected');
    expect((rb as PromiseRejectedResult).reason.code).toBe('P0409');
    expect(await soQty()).toBe(1);
    expect(await delivered()).toBe(1);
  });

  test('DO ships first, amendment cuts second: the cut waits and is refused', async () => {
    const [ra, rb] = await race(
      (tx) => tx`INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id, qty) VALUES (${DO2}, ${SO}, 1)`,
      (tx) => tx`UPDATE scm.mfg_sales_order_items SET qty = 1 WHERE id = ${SO}`,
    );
    expect(ra.status).toBe('fulfilled');
    expect(rb.status).toBe('rejected');
    expect((rb as PromiseRejectedResult).reason.code).toBe('P0409');
    expect(await soQty()).toBe(2);
    expect(await delivered()).toBe(2);
  });

  test('an already-over line takes an unrelated edit, a same-qty write and a raise; a deeper cut is refused', async () => {
    // Prod's shape: 3 shipped against qty 2, from before the guard.
    await a.unsafe('ALTER TABLE scm.delivery_order_items DISABLE TRIGGER trg_do_item_so_over_delivery');
    await a`INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id, qty) VALUES (${DO2}, ${SO}, 2)`;
    await a.unsafe('ALTER TABLE scm.delivery_order_items ENABLE TRIGGER trg_do_item_so_over_delivery');

    expect(await codeOf(a`UPDATE scm.mfg_sales_order_items SET note = 'x' WHERE id = ${SO}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.mfg_sales_order_items SET qty = qty, note = 'y' WHERE id = ${SO}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.mfg_sales_order_items SET qty = 1 WHERE id = ${SO}`)).toBe('P0409');
    expect(await codeOf(a`UPDATE scm.mfg_sales_order_items SET qty = 5 WHERE id = ${SO}`)).toBeNull();
    // A cut that stays at or above what shipped passes.
    expect(await codeOf(a`UPDATE scm.mfg_sales_order_items SET qty = 3 WHERE id = ${SO}`)).toBeNull();
    expect(await codeOf(a`UPDATE scm.mfg_sales_order_items SET qty = 2 WHERE id = ${SO}`)).toBe('P0409');
  });

  test('a cancelled DO does not hold the floor up', async () => {
    await a`UPDATE scm.delivery_orders SET status = 'CANCELLED' WHERE id = ${DO1}`;
    expect(await codeOf(a`UPDATE scm.mfg_sales_order_items SET qty = 0 WHERE id = ${SO}`)).toBeNull();
  });
});
