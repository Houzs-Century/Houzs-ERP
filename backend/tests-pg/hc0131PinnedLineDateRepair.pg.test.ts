import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types.
import { planPinned, readPinned, writeOrder } from '../scripts/lib/hc0131-pinned-line-date-sql.mjs';

/* HC-0131 — repair-hc0131-pinned-line-dates.mjs's SQL on a real postgres with
 * the SO / DO / invoice statuses as enums, so the ::text comparisons are
 * exercised (HC-0106). SKIPPED without TEST_DATABASE_URL (CI: backend-postgres
 * -> npm run test:pg). */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const DB = 'hc0131_pinned_line_date_repair';
const CO = 1;
const L = (n: number) => `0131${String(n).padStart(4, '0')}-0000-4000-8000-000000000000`;

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

/* Production on 2026-10-20: HC-SO-2609-081 header 24/10, every line pinned on
   9/10, a cancelled DO in its history. The rest are the shapes around it. */
async function seed(sql: Sql): Promise<void> {
  await sql.unsafe(`
    INSERT INTO scm.mfg_sales_orders (doc_no, company_id, status, customer_delivery_date) VALUES
      ('HC-SO-2609-081', 1, 'READY_TO_SHIP', '2026-10-24'),
      ('HC-SO-000200', 1, 'CONFIRMED', '2026-11-01'),
      ('HC-SO-000201', 1, 'CONFIRMED', '2026-11-01'),
      ('HC-SO-000202', 1, 'CONFIRMED', '2026-11-01'),
      ('HC-SO-000203', 1, 'CONFIRMED', '2026-11-01'),
      ('HC-SO-000204', 1, 'DELIVERED', '2026-11-01'),
      ('HC-SO-000205', 2, 'CONFIRMED', '2026-11-01'),
      ('HC-SO-000206', 1, 'CONFIRMED', '2026-11-01');
    INSERT INTO scm.mfg_sales_order_items (id, doc_no, item_code, line_delivery_date, line_delivery_date_overridden, cancelled) VALUES
      ('${L(1)}', 'HC-SO-2609-081', 'AKEMI IMMORTAL MATT (K)', '2026-10-09', true, false),
      ('${L(2)}', 'HC-SO-2609-081', 'JAGER-(Q)', '2026-10-09', true, false),
      ('${L(3)}', 'HC-SO-2609-081', 'HAPPY SLEEP EASY', '2026-10-09', true, false),
      ('${L(4)}', 'HC-SO-2609-081', 'CANCELLED', '2026-09-01', false, true),
      ('${L(5)}', 'HC-SO-000200', 'MIRROR-A', '2026-11-01', true, false),
      ('${L(6)}', 'HC-SO-000200', 'MIRROR-B', '2026-11-01', true, false),
      ('${L(7)}', 'HC-SO-000201', 'ON-HEADER', '2026-11-01', true, false),
      ('${L(8)}', 'HC-SO-000201', 'OWN-DATE', '2026-11-20', true, false),
      ('${L(9)}', 'HC-SO-000202', 'DESKTOP-FOLLOWS', '2026-11-01', false, false),
      ('${L(10)}', 'HC-SO-000202', 'DESKTOP-PINNED', '2026-11-20', true, false),
      ('${L(11)}', 'HC-SO-000203', 'HAND-EDITED', '2026-10-01', true, false),
      ('${L(12)}', 'HC-SO-000204', 'DELIVERED', '2026-10-01', true, false),
      ('${L(13)}', 'HC-SO-000205', 'OTHER-CO', '2026-10-01', true, false),
      ('${L(14)}', 'HC-SO-000206', 'ON-DO', '2026-10-01', false, false),
      ('${L(15)}', 'HC-SO-000206', 'PINNED', '2026-10-01', true, false);
    INSERT INTO scm.delivery_orders VALUES ('${L(21)}', 'HC-SO-2609-081', 'CANCELLED'), ('${L(22)}', 'HC-SO-000206', 'LOADED');
    INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id) VALUES ('${L(21)}', '${L(1)}'), ('${L(22)}', '${L(14)}');
    INSERT INTO scm.mfg_so_audit_log (so_doc_no, company_id, action, field_changes) VALUES
      ('HC-SO-000203', 1, 'UPDATE_LINE', '[{"field":"lineDeliveryDate","from":"2026-11-01","to":"2026-10-01"}]'),
      ('HC-SO-2609-081', 1, 'UPDATE_STATUS', '[{"field":"status","from":"DELIVERED","to":"READY_TO_SHIP"}]');
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
  sql.begin((tx) => writeOrder(tx, { companyId: CO, order, note: 'HC-0131 test' }));

const lineRows = async (sql: Sql, docNo: string) =>
  (await sql`SELECT item_code, line_delivery_date::text AS d, line_delivery_date_overridden AS o
    FROM scm.mfg_sales_order_items WHERE doc_no = ${docNo} ORDER BY item_code`).map((r) => [r.item_code, r.d, r.o]);

describePg('HC-0131 — lines the phone pinned follow the header again, on real enum columns', () => {
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

  test('HC-SO-2609-081 drifted, HC-SO-000200 mirrors, HC-SO-000201 named, HC-SO-000206 by its unfrozen line; a desktop pin, a hand edit in history, a frozen line, delivered and other-company orders are not planned', async () => {
    const { drifted, mirrors, mixed } = planPinned(await readPinned(db, CO));
    expect(drifted.map((o: { docNo: string }) => o.docNo)).toEqual(['HC-SO-000206', 'HC-SO-2609-081']);
    expect(drifted[1]).toEqual({
      docNo: 'HC-SO-2609-081', status: 'READY_TO_SHIP', from: '2026-10-09', to: '2026-10-24',
      lines: [
        { id: L(1), itemCode: 'AKEMI IMMORTAL MATT (K)', from: '2026-10-09' },
        { id: L(3), itemCode: 'HAPPY SLEEP EASY', from: '2026-10-09' },
        { id: L(2), itemCode: 'JAGER-(Q)', from: '2026-10-09' },
      ],
    });
    expect(mirrors.map((o: { docNo: string; lines: unknown[] }) => [o.docNo, o.lines.length])).toEqual([['HC-SO-000200', 2]]);
    expect(mixed.map((o: { docNo: string; from: string[] }) => [o.docNo, o.from])).toEqual([['HC-SO-000201', ['2026-11-01', '2026-11-20']]]);
  });

  test('a pinned order with a line on a live delivery order plans its unfrozen lines only', async () => {
    const { drifted } = planPinned(await readPinned(db, CO, ['HC-SO-000206']));
    expect(drifted.map((o: { lines: Array<{ itemCode: string }> }) => o.lines.map((l) => l.itemCode))).toEqual([['PINNED']]);
  });

  test('a live delivery-order line naming no SO line freezes the whole order', async () => {
    await db.unsafe(`INSERT INTO scm.delivery_orders VALUES ('${L(23)}', 'HC-SO-2609-081', 'DRAFT');
      INSERT INTO scm.delivery_order_items (delivery_order_id, so_item_id) VALUES ('${L(23)}', NULL);`);
    expect(await readPinned(db, CO, ['HC-SO-2609-081'])).toEqual([]);
  });

  test('apply moves and unpins the drifted lines, unpins the mirrors, one history row each; a second read plans only the order not yet written', async () => {
    const { drifted, mirrors } = planPinned(await readPinned(db, CO));
    const so081 = drifted.find((o: { docNo: string }) => o.docNo === 'HC-SO-2609-081');
    expect(await write(db, so081)).toBe(3);
    expect(await write(db, mirrors[0])).toBe(2);
    expect(await lineRows(db, 'HC-SO-2609-081')).toEqual([
      ['AKEMI IMMORTAL MATT (K)', '2026-10-24', false],
      ['CANCELLED', '2026-09-01', false],
      ['HAPPY SLEEP EASY', '2026-10-24', false],
      ['JAGER-(Q)', '2026-10-24', false],
    ]);
    expect(await lineRows(db, 'HC-SO-000200')).toEqual([
      ['MIRROR-A', '2026-11-01', false],
      ['MIRROR-B', '2026-11-01', false],
    ]);
    const audits = await db`SELECT so_doc_no, field_changes FROM scm.mfg_so_audit_log
      WHERE actor_name_snapshot = 'System (HC-0131 repair)' ORDER BY so_doc_no`;
    expect(audits.map((a) => [a.so_doc_no, a.field_changes])).toEqual([
      ['HC-SO-000200', [{ field: 'lineDeliveryDateOverridden', from: true, to: false, lines: 2 }]],
      ['HC-SO-2609-081', [
        { field: 'line_delivery_date', from: '2026-10-09', to: '2026-10-24', lines: 3 },
        { field: 'lineDeliveryDateOverridden', from: true, to: false, lines: 3 },
      ]],
    ]);
    expect(await write(db, so081)).toBe(0);
    const again = planPinned(await readPinned(db, CO));
    expect([again.drifted.length, again.mirrors.length]).toEqual([1, 0]);
    expect(again.drifted[0].docNo).toBe('HC-SO-000206');
  });

  test('a line unpinned, or a header moved, between plan and apply is not written', async () => {
    const so081 = planPinned(await readPinned(db, CO, ['HC-SO-2609-081'])).drifted[0];
    await db`UPDATE scm.mfg_sales_order_items SET line_delivery_date_overridden = false WHERE id = ${L(1)}`;
    expect(await write(db, so081)).toBe(2);
    await db.unsafe(FIXTURE);
    await seed(db);
    await db`UPDATE scm.mfg_sales_orders SET customer_delivery_date = '2026-11-05' WHERE doc_no = 'HC-SO-2609-081'`;
    expect(await write(db, so081)).toBe(0);
    expect((await db`SELECT count(*)::int AS n FROM scm.mfg_so_audit_log WHERE source = 'script'`)[0]!.n).toBe(0);
  });
});
