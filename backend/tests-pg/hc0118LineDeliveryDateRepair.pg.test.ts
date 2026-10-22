import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types.
import { planDrift, readDrift, writeOrder } from '../scripts/lib/hc0118-line-delivery-date-sql.mjs';

/* HC-0118 — repair-hc0118-line-delivery-dates.mjs's SQL on a real postgres
 * with the SO / DO / invoice statuses as enums, so the ::text comparisons are
 * exercised (HC-0106 died on an enum compare no fake client could show).
 * SKIPPED without TEST_DATABASE_URL (CI: backend-postgres -> npm run test:pg). */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const DB = 'hc0118_line_delivery_date_repair';
const CO = 1;
const L = (n: number) => `0118${String(n).padStart(4, '0')}-0000-4000-8000-000000000000`;

const FIXTURE = `
  DROP SCHEMA IF EXISTS scm CASCADE;
  CREATE SCHEMA scm;
  CREATE TYPE scm.mfg_so_status AS ENUM ('DRAFT','CONFIRMED','IN_PRODUCTION','READY_TO_SHIP','SHIPPED','DELIVERED','INVOICED','CLOSED','CANCELLED','ON_HOLD');
  CREATE TYPE scm.do_status AS ENUM ('DRAFT','LOADED','DISPATCHED','DELIVERED','CANCELLED');
  CREATE TYPE scm.si_status AS ENUM ('DRAFT','POSTED','CANCELLED');
  CREATE TYPE scm.so_audit_action AS ENUM ('CREATE','UPDATE','UPDATE_DETAILS','UPDATE_STATUS','UPDATE_LINE');
  CREATE TABLE scm.mfg_sales_orders (
    doc_no text PRIMARY KEY, company_id bigint NOT NULL, status scm.mfg_so_status NOT NULL,
    customer_delivery_date date, updated_at timestamptz
  );
  CREATE TABLE scm.mfg_sales_order_items (
    id uuid PRIMARY KEY, doc_no text NOT NULL, item_code text, cancelled boolean DEFAULT false,
    line_delivery_date date, line_delivery_date_overridden boolean DEFAULT false
  );
  CREATE TABLE scm.delivery_orders (id uuid PRIMARY KEY, so_doc_no text, status scm.do_status NOT NULL);
  CREATE TABLE scm.delivery_order_items (id serial PRIMARY KEY, delivery_order_id uuid NOT NULL, so_item_id uuid);
  CREATE TABLE scm.sales_invoices (id uuid PRIMARY KEY, so_doc_no text, status scm.si_status NOT NULL);
  CREATE TABLE scm.sales_invoice_items (id serial PRIMARY KEY, sales_invoice_id uuid NOT NULL, so_item_id uuid, do_item_id uuid);
  CREATE TABLE scm.mfg_so_audit_log (
    id serial PRIMARY KEY, so_doc_no text NOT NULL, company_id bigint NOT NULL,
    action scm.so_audit_action NOT NULL, actor_name_snapshot text, field_changes jsonb,
    status_snapshot scm.mfg_so_status, source text, note text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

/* Production on 2026-10-19: HC-SO-012526 header 30/10, three lines still 15/09
   (not hand-set, not frozen), STORAGE blank. The rest are the shapes left alone. */
async function seed(sql: Sql): Promise<void> {
  await sql.unsafe(`
    INSERT INTO scm.mfg_sales_orders (doc_no, company_id, status, customer_delivery_date) VALUES
      ('HC-SO-012526', 1, 'READY_TO_SHIP', '2026-10-30'),
      ('HC-SO-000100', 1, 'CONFIRMED', '2026-11-01'),
      ('HC-SO-000101', 1, 'DELIVERED', '2026-11-01'),
      ('HC-SO-000102', 1, 'CONFIRMED', '2026-11-01'),
      ('HC-SO-000103', 2, 'CONFIRMED', '2026-11-01');
    INSERT INTO scm.mfg_sales_order_items (id, doc_no, item_code, line_delivery_date, line_delivery_date_overridden, cancelled) VALUES
      ('${L(1)}', 'HC-SO-012526', '9028-2A(LHF)', '2026-09-15', false, false),
      ('${L(2)}', 'HC-SO-012526', '9028-L(RHF)', '2026-09-15', false, false),
      ('${L(3)}', 'HC-SO-012526', 'SQUARE PILLOW', '2026-09-15', false, false),
      ('${L(4)}', 'HC-SO-012526', 'STORAGE', NULL, false, false),
      ('${L(5)}', 'HC-SO-000100', 'MIXED-A', '2026-09-01', false, false),
      ('${L(6)}', 'HC-SO-000100', 'MIXED-B', '2026-09-02', false, false),
      ('${L(7)}', 'HC-SO-000101', 'DELIVERED', '2026-09-01', false, false),
      ('${L(8)}', 'HC-SO-000102', 'HAND-SET', '2026-09-01', true, false),
      ('${L(9)}', 'HC-SO-000102', 'ON-DO', '2026-09-01', false, false),
      ('${L(10)}', 'HC-SO-000102', 'ON-SI', '2026-09-01', false, false),
      ('${L(11)}', 'HC-SO-000102', 'CANCELLED', '2026-09-01', false, true),
      ('${L(12)}', 'HC-SO-000103', 'OTHER-CO', '2026-09-01', false, false);
    INSERT INTO scm.delivery_orders VALUES ('${L(21)}', 'HC-SO-000102', 'LOADED'), ('${L(22)}', 'HC-SO-012526', 'CANCELLED');
    INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id) VALUES ('${L(21)}', '${L(9)}'), ('${L(22)}', '${L(1)}');
    INSERT INTO scm.sales_invoices VALUES ('${L(31)}', 'HC-SO-000102', 'POSTED');
    INSERT INTO scm.sales_invoice_items (sales_invoice_id, so_item_id) VALUES ('${L(31)}', '${L(10)}');
  `);
}

let admin: Sql;
let db: Sql;

function urlFor(name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

const write = async (sql: Sql, order: unknown) =>
  sql.begin((tx) => writeOrder(tx, { companyId: CO, order, note: 'HC-0118 test' }));

describePg('HC-0118 — line delivery dates back to the header, on real enum columns', () => {
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

  test('the plan is HC-SO-012526 alone; the mixed order is named; hand-set, frozen, blank, cancelled, delivered and other-company lines are not read', async () => {
    const { planned, mixed } = planDrift(await readDrift(db, CO));
    expect(planned).toEqual([{
      docNo: 'HC-SO-012526', status: 'READY_TO_SHIP', from: '2026-09-15', to: '2026-10-30',
      lines: [
        { id: L(1), itemCode: '9028-2A(LHF)', from: '2026-09-15' },
        { id: L(2), itemCode: '9028-L(RHF)', from: '2026-09-15' },
        { id: L(3), itemCode: 'SQUARE PILLOW', from: '2026-09-15' },
      ],
    }]);
    expect(mixed.map((o: { docNo: string; from: string[] }) => [o.docNo, o.from])).toEqual([['HC-SO-000100', ['2026-09-01', '2026-09-02']]]);
  });

  test('DOCS narrows the read', async () => {
    expect(await readDrift(db, CO, ['HC-SO-000102'])).toEqual([]);
    expect((await readDrift(db, CO, ['HC-SO-012526'])).length).toBe(3);
  });

  test('a live delivery-order line naming no SO line freezes the whole order', async () => {
    await db.unsafe(`INSERT INTO scm.delivery_orders VALUES ('${L(23)}', 'HC-SO-012526', 'DRAFT');
      INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id) VALUES ('${L(23)}', NULL);`);
    expect(await readDrift(db, CO, ['HC-SO-012526'])).toEqual([]);
  });

  test('apply moves the three lines, keeps the flags, writes one history row; a second apply writes nothing', async () => {
    const { planned } = planDrift(await readDrift(db, CO));
    expect(await write(db, planned[0])).toBe(3);
    const lines = await db`SELECT item_code, line_delivery_date::text AS d, line_delivery_date_overridden AS o
      FROM scm.mfg_sales_order_items WHERE doc_no = 'HC-SO-012526' ORDER BY item_code`;
    expect(lines.map((r) => [r.item_code, r.d, r.o])).toEqual([
      ['9028-2A(LHF)', '2026-10-30', false],
      ['9028-L(RHF)', '2026-10-30', false],
      ['SQUARE PILLOW', '2026-10-30', false],
      ['STORAGE', null, false],
    ]);
    const audits = await db`SELECT so_doc_no, action::text AS action, field_changes, status_snapshot::text AS s FROM scm.mfg_so_audit_log`;
    expect(audits).toEqual([{
      so_doc_no: 'HC-SO-012526', action: 'UPDATE_LINE', s: 'READY_TO_SHIP',
      field_changes: [{ field: 'line_delivery_date', from: '2026-09-15', to: '2026-10-30', lines: 3 }],
    }]);
    expect(await write(db, planned[0])).toBe(0);
    expect((await db`SELECT count(*)::int AS n FROM scm.mfg_so_audit_log`)[0]!.n).toBe(1);
    expect(planDrift(await readDrift(db, CO)).planned).toEqual([]);
  });

  test('a line hand-set, or a header moved, between plan and apply is not written', async () => {
    const { planned } = planDrift(await readDrift(db, CO));
    await db`UPDATE scm.mfg_sales_order_items SET line_delivery_date_overridden = true WHERE id = ${L(1)}`;
    expect(await write(db, planned[0])).toBe(2);
    await db.unsafe(FIXTURE);
    await seed(db);
    await db`UPDATE scm.mfg_sales_orders SET customer_delivery_date = '2026-11-05' WHERE doc_no = 'HC-SO-012526'`;
    expect(await write(db, planned[0])).toBe(0);
    expect((await db`SELECT count(*)::int AS n FROM scm.mfg_so_audit_log`)[0]!.n).toBe(0);
  });
});
