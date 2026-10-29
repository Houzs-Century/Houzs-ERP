import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types; the SAME splitter pg-migrate.mjs uses.
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';

/* HC-0004 — an SO line cannot be DELETED while a live DO ships it, and a
 * Delivery Return cannot be cancelled into an over-delivered SO line.
 *
 * Proves, on a real postgres, with the SO -> DO cap (20261014T1300) and
 * 20261029T1000 applied:
 *   - a DO confirming and a line delete racing: the second writer waits on the
 *     row lock and is refused (delete: P0409; DO insert after a delete: FK);
 *   - a line only DRAFT / CANCELLED DOs point at still deletes;
 *   - cancelling a DR that would put a line above its qty is refused.
 * SKIPPED without TEST_DATABASE_URL (CI: backend-postgres -> npm run test:pg). */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const DB = 'hc0004_so_delete_floor';
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

async function applyMigrations(sql: Sql): Promise<void> {
  for (const suffix of ['_scm_so_line_over_delivery_guard.sql', '_scm_so_line_delete_floor.sql']) {
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

const DR1 = '00000000-0000-0000-0000-0000000000e1';

async function soLines(): Promise<number> {
  const [r] = await a<Array<{ n: number }>>`SELECT count(*)::int AS n FROM scm.mfg_sales_order_items WHERE id = ${SO}`;
  return r!.n;
}

async function linked(): Promise<number> {
  const [r] = await a<Array<{ n: number }>>`SELECT count(*)::int AS n FROM scm.delivery_order_items WHERE so_item_id = ${SO}`;
  return r!.n;
}

describePg('HC-0004 — SO line delete floor and DR cancel cap', () => {
  beforeAll(async () => {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') throw new Error('refusing a non-local TEST_DATABASE_URL');
    admin = postgres(url, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${DB}`);
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
    await a`INSERT INTO scm.mfg_sales_order_items (id, qty) VALUES (${SO}, 5)`;
    await a`INSERT INTO scm.delivery_orders (id, do_number, status) VALUES (${DO1}, 'DO-1', 'DRAFT'), (${DO2}, 'DO-2', 'DRAFT')`;
  });

  test('a DO confirms first, the amendment delete waits and is refused; the DO line keeps its SO line', async () => {
    await a`INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id, qty) VALUES (${DO1}, ${SO}, 5)`;
    const [ra, rb] = await race(
      (tx) => tx`UPDATE scm.delivery_orders SET status = 'LOADED' WHERE id = ${DO1}`,
      (tx) => tx`DELETE FROM scm.mfg_sales_order_items WHERE id = ${SO}`,
    );
    expect(ra.status).toBe('fulfilled');
    expect(rb.status).toBe('rejected');
    expect((rb as PromiseRejectedResult).reason.code).toBe('P0409');
    expect(await soLines()).toBe(1);
    expect(await linked()).toBe(1);
  });

  test('the delete goes first, a DO line insert waits and is refused', async () => {
    const [ra, rb] = await race(
      (tx) => tx`DELETE FROM scm.mfg_sales_order_items WHERE id = ${SO}`,
      (tx) => tx`INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id, qty) VALUES (${DO2}, ${SO}, 1)`,
    );
    expect(ra.status).toBe('fulfilled');
    expect(rb.status).toBe('rejected');
    expect((rb as PromiseRejectedResult).reason.code).toBe('23503');
    expect(await soLines()).toBe(0);
  });

  test('a live DO line refuses a plain delete; DRAFT and CANCELLED ones do not', async () => {
    await a`INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id, qty) VALUES (${DO1}, ${SO}, 2)`; // DRAFT
    await a`UPDATE scm.delivery_orders SET status = 'DISPATCHED' WHERE id = ${DO2}`;
    await a`INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id, qty) VALUES (${DO2}, ${SO}, 2)`;
    expect(await codeOf(a`DELETE FROM scm.mfg_sales_order_items WHERE id = ${SO}`)).toBe('P0409');
    await a`UPDATE scm.delivery_orders SET status = 'CANCELLED' WHERE id = ${DO2}`;
    expect(await codeOf(a`DELETE FROM scm.mfg_sales_order_items WHERE id = ${SO}`)).toBeNull();
    expect(await soLines()).toBe(0);
  });

  test('cancelling a DR that would push the line over its qty is refused', async () => {
    // qty 5: DO1 ships 5, DR returns 2, DO2 ships 2; cancelling the DR makes 7.
    await a`UPDATE scm.delivery_orders SET status = 'LOADED' WHERE id = ${DO1}`;
    const [d1] = await a<Array<{ id: string }>>`INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id, qty) VALUES (${DO1}, ${SO}, 5) RETURNING id`;
    await a`INSERT INTO scm.delivery_returns (id, status) VALUES (${DR1}, 'PENDING')`;
    await a`INSERT INTO scm.delivery_return_items (delivery_return_id, do_item_id, qty_returned) VALUES (${DR1}, ${d1!.id}, 2)`;
    await a`UPDATE scm.delivery_orders SET status = 'LOADED' WHERE id = ${DO2}`;
    await a`INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id, qty) VALUES (${DO2}, ${SO}, 2)`;

    expect(await codeOf(a`UPDATE scm.delivery_returns SET status = 'CANCELLED' WHERE id = ${DR1}`)).toBe('P0409');
    const [r] = await a<Array<{ status: string }>>`SELECT status FROM scm.delivery_returns WHERE id = ${DR1}`;
    expect(r!.status).toBe('PENDING');
    // Once DO2 is gone the cancel fits, and a non-cancel status move is never checked.
    expect(await codeOf(a`UPDATE scm.delivery_returns SET status = 'RECEIVED' WHERE id = ${DR1}`)).toBeNull();
    await a`UPDATE scm.delivery_orders SET status = 'CANCELLED' WHERE id = ${DO2}`;
    expect(await codeOf(a`UPDATE scm.delivery_returns SET status = 'CANCELLED' WHERE id = ${DR1}`)).toBeNull();
  });
});
