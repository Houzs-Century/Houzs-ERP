import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types.
import { planCosts, productsNotFixed, readDeliveryLines, readLines, readProductCosts, writeOrder } from '../scripts/lib/hc0207-so-cost-sql.mjs';

/* HC-0207 — repair-hc0207-so-cost.mjs's SQL on a real postgres with the SO / DO
 * statuses as enums, so the ::text comparisons are exercised (HC-0106). SKIPPED
 * without TEST_DATABASE_URL (CI: backend-postgres -> npm run test:pg). */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const DB = 'hc0207_so_cost_repair';
const CO = 1;
const S = 'DUNLOPILLO OTHOREST GENERASI 3.0 20CM MATT (S)';
const SS = 'DUNLOPILLO OTHOREST GENERASI 3.0 20CM MATT (SS)';
const L = (n: number) => `0207${String(n).padStart(4, '0')}-0000-4000-8000-000000000000`;

const FIXTURE = `
  DROP SCHEMA IF EXISTS scm CASCADE;
  CREATE SCHEMA scm;
  CREATE TYPE scm.mfg_so_status AS ENUM ('DRAFT','CONFIRMED','IN_PRODUCTION','DELIVERED','CANCELLED');
  CREATE TYPE scm.do_status AS ENUM ('DRAFT','DELIVERED','CANCELLED');
  CREATE TYPE scm.so_audit_action AS ENUM ('UPDATE_LINE');
  CREATE TABLE scm.mfg_sales_orders (
    doc_no text NOT NULL, company_id bigint NOT NULL, status scm.mfg_so_status NOT NULL,
    total_revenue_sen bigint, mattress_sofa_cost_sen bigint, total_cost_sen bigint,
    total_margin_sen bigint, margin_pct_basis integer, PRIMARY KEY (doc_no, company_id)
  );
  CREATE TABLE scm.mfg_sales_order_items (
    id uuid PRIMARY KEY, doc_no text NOT NULL, company_id bigint NOT NULL, item_code text,
    qty numeric, cancelled boolean DEFAULT false,
    unit_cost_sen integer, line_cost_sen integer, line_margin_sen integer
  );
  CREATE TABLE scm.mfg_products (code text, company_id bigint, base_price_sen integer);
  CREATE TABLE scm.delivery_orders (id uuid PRIMARY KEY, do_number text, status scm.do_status NOT NULL);
  CREATE TABLE scm.delivery_order_items (
    id serial PRIMARY KEY, delivery_order_id uuid NOT NULL, so_item_id uuid, unit_cost_sen integer
  );
  CREATE TABLE scm.mfg_so_audit_log (
    id serial PRIMARY KEY, so_doc_no text NOT NULL, company_id bigint NOT NULL,
    action scm.so_audit_action NOT NULL, actor_name_snapshot text, field_changes jsonb,
    status_snapshot scm.mfg_so_status, source text, note text
  );
`;

/* Production on 2026-11-04: HC-SO-2610-084 two (S), HC-SO-004928 one of each on
   the same order. The rest are the shapes around them. */
async function seed(sql: Sql): Promise<void> {
  await sql.unsafe(`
    INSERT INTO scm.mfg_sales_orders VALUES
      ('HC-SO-2610-084', 1, 'IN_PRODUCTION', 200000, 110000, 110000, 90000, 4500),
      ('HC-SO-004928', 1, 'DELIVERED', 300000, 101500, 101500, 198500, 6617),
      ('HC-SO-000300', 1, 'CONFIRMED', 100000, 46500, 46500, 53500, 5350),
      ('HC-SO-000301', 1, 'CONFIRMED', 100000, 60000, 60000, 40000, 4000),
      ('HC-SO-000302', 1, 'CANCELLED', 100000, 55000, 55000, 45000, 4500),
      ('HC-SO-000303', 2, 'CONFIRMED', 100000, 55000, 55000, 45000, 4500),
      ('HC-SO-000304', 1, 'CONFIRMED', 100000, 55000, 55000, 45000, 4500);
    INSERT INTO scm.mfg_sales_order_items (id, doc_no, company_id, item_code, qty, cancelled, unit_cost_sen, line_cost_sen, line_margin_sen) VALUES
      ('${L(1)}', 'HC-SO-2610-084', 1, '${S}', 2, false, 55000, 110000, 90000),
      ('${L(2)}', 'HC-SO-004928', 1, '${S}', 1, false, 55000, 55000, 95000),
      ('${L(3)}', 'HC-SO-004928', 1, '${SS}', 1, false, 46500, 46500, 103500),
      ('${L(4)}', 'HC-SO-000300', 1, '${S}', 1, false, 46500, 46500, 53500),
      ('${L(5)}', 'HC-SO-000301', 1, '${S}', 1, false, 60000, 60000, 40000),
      ('${L(6)}', 'HC-SO-000302', 1, '${S}', 1, false, 55000, 55000, 45000),
      ('${L(7)}', 'HC-SO-000303', 2, '${S}', 1, false, 55000, 55000, 45000),
      ('${L(8)}', 'HC-SO-000304', 1, '${S}', 1, true, 55000, 55000, 45000),
      ('${L(9)}', 'HC-SO-000304', 1, 'SOME OTHER MATT (S)', 1, false, 55000, 55000, 45000);
    INSERT INTO scm.mfg_products VALUES ('${S}', 1, 55000), ('${SS}', 1, 46500);
    INSERT INTO scm.delivery_orders VALUES ('${L(21)}', 'DO-1', 'DELIVERED'), ('${L(22)}', 'DO-2', 'CANCELLED');
    INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id, unit_cost_sen) VALUES
      ('${L(21)}', '${L(2)}', 50000), ('${L(22)}', '${L(3)}', 50000);
  `);
}

let admin: Sql;
let db: Sql;

function urlFor(name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

const plan = async () => planCosts(await readLines(db, CO));
const write = async (order: unknown) =>
  db.begin((tx) => writeOrder(tx, { companyId: CO, order, note: 'HC-0207 test' }));
const header = async (docNo: string) =>
  (await db`SELECT mattress_sofa_cost_sen::int AS ms, total_cost_sen::int AS tot, total_margin_sen::int AS mar, margin_pct_basis AS pct
    FROM scm.mfg_sales_orders WHERE doc_no = ${docNo}`)[0];
const line = async (id: string) =>
  (await db`SELECT unit_cost_sen AS u, line_cost_sen AS c, line_margin_sen AS m FROM scm.mfg_sales_order_items WHERE id = ${id}::uuid`)[0];

describePg('HC-0207 — SO lines on the swapped OTHOREST cost, on real enum columns', () => {
  beforeAll(async () => {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') throw new Error('refusing a non-local TEST_DATABASE_URL');
    admin = postgres(url, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${DB}`);
    db = postgres(urlFor(DB), { max: 1, prepare: false });
  });

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await db.unsafe(FIXTURE);
    await seed(db);
  });

  test('plans the swapped lines only; a right cost is done, another cost is named; cancelled lines and orders, other codes and the other company are not read', async () => {
    const { orders, done, other } = await plan();
    expect(orders.map((o: { docNo: string; deltaSen: number }) => [o.docNo, o.deltaSen])).toEqual([
      ['HC-SO-004928', 0],
      ['HC-SO-2610-084', -17000],
    ]);
    expect(done.map((r: { doc_no: string }) => r.doc_no)).toEqual(['HC-SO-000300']);
    expect(other.map((r: { doc_no: string }) => r.doc_no)).toEqual(['HC-SO-000301']);
  });

  test('apply moves the lines and the header by the difference, with one history row', async () => {
    const { orders } = await plan();
    const so084 = orders.find((o: { docNo: string }) => o.docNo === 'HC-SO-2610-084');
    expect(await write(so084)).toBe(1);
    expect(await line(L(1))).toEqual({ u: 46500, c: 93000, m: 107000 });
    expect(await header('HC-SO-2610-084')).toEqual({ ms: 93000, tot: 93000, mar: 107000, pct: 5350 });
    const audit = await db`SELECT action::text AS action, status_snapshot::text AS status, source, field_changes FROM scm.mfg_so_audit_log`;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'UPDATE_LINE', status: 'IN_PRODUCTION', source: 'script' });
    expect(audit[0]!.field_changes).toEqual([{ field: 'unit_cost_sen', itemCode: S, from: 55000, to: 46500 }]);
  });

  test('an order holding one of each moves both lines and leaves its header totals where they were', async () => {
    const { orders } = await plan();
    expect(await write(orders[0])).toBe(2);
    expect(await line(L(2))).toEqual({ u: 46500, c: 46500, m: 103500 });
    expect(await line(L(3))).toEqual({ u: 55000, c: 55000, m: 95000 });
    expect(await header('HC-SO-004928')).toMatchObject({ ms: 101500, tot: 101500, mar: 198500 });
  });

  test('a second run plans nothing, and a line that moved since the read is not written', async () => {
    const { orders } = await plan();
    await db`UPDATE scm.mfg_sales_order_items SET unit_cost_sen = 60000 WHERE id = ${L(1)}::uuid`;
    const so084 = orders.find((o: { docNo: string }) => o.docNo === 'HC-SO-2610-084');
    expect(await write(so084)).toBe(0);
    expect(await header('HC-SO-2610-084')).toMatchObject({ tot: 110000 });
    for (const o of (await plan()).orders) await write(o);
    expect((await plan()).orders).toEqual([]);
  });

  test('the product check names both codes until they are corrected', async () => {
    expect(productsNotFixed(await readProductCosts(db, CO))).toHaveLength(2);
    await db`UPDATE scm.mfg_products SET base_price_sen = 46500 WHERE code = ${S}`;
    await db`UPDATE scm.mfg_products SET base_price_sen = 55000 WHERE code = ${SS}`;
    expect(productsNotFixed(await readProductCosts(db, CO))).toEqual([]);
  });

  test('delivery order lines are named from live delivery orders only', async () => {
    const rows = await readDeliveryLines(db, [L(2), L(3)]);
    expect(rows.map((r: { do_number: string; status: string }) => [r.do_number, r.status])).toEqual([['DO-1', 'DELIVERED']]);
  });
});
