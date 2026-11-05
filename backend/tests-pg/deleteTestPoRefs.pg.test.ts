/* EXECUTES the SQL behind `scripts/delete-test-po.mjs` against real Postgres:
 * the reference sweep, the classification, the liveness guard, the child
 * deletes themselves, and the control. Twin of deleteTestSoRefs.pg.test.ts.
 *
 * A PO is named by its number AND by uuid (its own and its lines'), and some
 * tables keep that uuid as TEXT. Each of those shapes is seeded here, and the
 * sweep has to find every one. SKIPPED without TEST_DATABASE_URL.
 */
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  AUDIT, CHILD, CHILD_TABLES, DOWNSTREAM, UNCLASSIFIED,
  bindMatch, classifyReference, controlDrift, controlSnapshot,
  poBlockers, referenceColumns, sweepReferences,
} from '../scripts/lib/delete-test-po-refs.mjs';

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

let sql: Sql;

const PO = { id: '11111111-1111-1111-1111-111111111111', po_number: 'HC-PO-2611-001' };
const OTHER = '22222222-2222-2222-2222-222222222222';
const LINE_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const LINE_B = 'aaaaaaaa-0000-0000-0000-000000000002';
const LINE_OTHER = 'bbbbbbbb-0000-0000-0000-000000000001';

async function schema(db: Sql) {
  await db.unsafe(`
    DROP SCHEMA IF EXISTS scm CASCADE;
    CREATE SCHEMA scm;
    -- status is an enum in production; a text fixture would hide a bad cast.
    CREATE TYPE scm.po_status AS ENUM ('DRAFT', 'SUBMITTED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED', 'ON_HOLD');

    CREATE TABLE scm.purchase_orders (
      id uuid PRIMARY KEY, po_number text NOT NULL, status scm.po_status, company_id bigint,
      total_sen integer DEFAULT 0, linked_ac_docno text
    );
    CREATE TABLE scm.purchase_order_items (
      id uuid PRIMARY KEY, purchase_order_id uuid NOT NULL REFERENCES scm.purchase_orders(id),
      so_item_id uuid, item_code text, qty int
    );
    CREATE TABLE scm.purchase_order_item_allocations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      purchase_order_item_id uuid NOT NULL REFERENCES scm.purchase_order_items(id) ON DELETE CASCADE, qty int
    );
    CREATE TABLE scm.po_amendments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      po_id uuid NOT NULL REFERENCES scm.purchase_orders(id) ON DELETE CASCADE, po_number text
    );
    CREATE TABLE scm.po_amendment_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      amendment_id uuid NOT NULL REFERENCES scm.po_amendments(id) ON DELETE CASCADE, purchase_order_item_id uuid
    );
    CREATE TABLE scm.po_revisions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), po_id uuid NOT NULL, revision int);
    CREATE TABLE scm.document_cancel_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), doc_type text, doc_key text, doc_number text
    );
    CREATE TABLE scm.autocount_outbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), op text, doc_type text, doc_no text, doc_id text,
      status text, ac_doc_no text, created_at timestamptz DEFAULT now()
    );
    CREATE TABLE scm.entity_audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_type text, entity_id text, entity_doc_no text
    );
    CREATE TABLE scm.grns (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), grn_number text, purchase_order_id uuid);
    CREATE TABLE scm.grn_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), grn_id uuid, purchase_order_item_id uuid);
    CREATE TABLE scm.inventory_movements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), movement_type text, source_doc_type text,
      source_doc_id text, batch_no text
    );
    CREATE TABLE scm.product_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), po_id uuid);
    -- On no list. The sweep has to find it by itself and refuse.
    CREATE TABLE scm.po_supplier_mail_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), purchase_order_id uuid);
    -- No id / doc-no shape in the column name: never scanned.
    CREATE TABLE scm.unrelated_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), body text);
  `);
}

async function seed(db: Sql) {
  await db.unsafe(`
    TRUNCATE scm.purchase_orders, scm.purchase_order_items, scm.purchase_order_item_allocations,
             scm.po_amendments, scm.po_amendment_lines, scm.po_revisions, scm.document_cancel_requests,
             scm.autocount_outbox, scm.entity_audit_log, scm.grns, scm.grn_items, scm.inventory_movements,
             scm.product_requests, scm.po_supplier_mail_log, scm.unrelated_notes CASCADE;

    -- The test PO carries its OWN number as the book number, as after a write-back.
    INSERT INTO scm.purchase_orders (id, po_number, status, company_id, total_sen, linked_ac_docno) VALUES
      ('${PO.id}', '${PO.po_number}', 'DRAFT', 1, 5000, '${PO.po_number}'),
      ('${OTHER}', 'HC-PO-2611-002', 'SUBMITTED', 1, 7000, 'PO-000441');
    INSERT INTO scm.purchase_order_items (id, purchase_order_id, item_code, qty) VALUES
      ('${LINE_A}', '${PO.id}', 'SOFA-A', 1),
      ('${LINE_B}', '${PO.id}', 'SOFA-B', 2),
      ('${LINE_OTHER}', '${OTHER}', 'SOFA-C', 1);
    INSERT INTO scm.purchase_order_item_allocations (purchase_order_item_id, qty) VALUES
      ('${LINE_A}', 1), ('${LINE_OTHER}', 1);
    INSERT INTO scm.po_amendments (id, po_id, po_number) VALUES
      ('cccccccc-0000-0000-0000-000000000001', '${PO.id}', '${PO.po_number}');
    INSERT INTO scm.po_amendment_lines (amendment_id, purchase_order_item_id) VALUES
      ('cccccccc-0000-0000-0000-000000000001', '${LINE_B}'),
      ('cccccccc-0000-0000-0000-000000000001', NULL);
    INSERT INTO scm.po_revisions (po_id, revision) VALUES ('${PO.id}', 1);
    INSERT INTO scm.document_cancel_requests (doc_type, doc_key, doc_number) VALUES
      ('PO', '${PO.id}', '${PO.po_number}'),
      -- An SO request that happens to carry the same number must survive.
      ('SO', 'x', '${PO.po_number}');
    INSERT INTO scm.autocount_outbox (op, doc_type, doc_no, doc_id, status, ac_doc_no) VALUES
      ('create_po', 'PO', '${PO.po_number}', '${PO.id}', 'sent', '${PO.po_number}'),
      ('cancel', 'PO', '${PO.po_number}', '${PO.id}', 'sent', NULL);
    INSERT INTO scm.entity_audit_log (entity_type, entity_id, entity_doc_no) VALUES
      ('PURCHASE_ORDER', '${PO.id}', '${PO.po_number}');
    INSERT INTO scm.unrelated_notes (body) VALUES ('${PO.po_number} mentioned in prose');
  `);
}

async function deleteLikeTheScript(db: Sql) {
  for (const t of CHILD_TABLES) {
    if (t.table === 'scm.purchase_order_lines') continue; // not in this fixture
    const { text, params } = bindMatch(t.match, PO);
    await db.unsafe(`DELETE FROM ${t.table} WHERE ${text}`, params);
  }
  await db.unsafe(`DELETE FROM scm.purchase_orders WHERE id = $1`, [PO.id]);
}

const keys = (s: { hits: { table: string; column: string }[] }) =>
  s.hits.map((h) => `${h.table}.${h.column}`).sort();

describePg('delete-test-po — the reference sweep, against real Postgres', () => {
  beforeAll(async () => {
    sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    await schema(sql);
  });
  beforeEach(async () => { await seed(sql); });
  afterAll(async () => { await sql?.end(); });

  test('candidate columns: uuid links and text ids/numbers, never a primary key or free text', async () => {
    const names = (await referenceColumns(sql)).map((c) => `${c.schema}.${c.table}.${c.column}`);
    expect(names).toContain('scm.purchase_order_items.purchase_order_id');
    expect(names).toContain('scm.grn_items.purchase_order_item_id');
    expect(names).toContain('scm.autocount_outbox.doc_id');
    expect(names).toContain('scm.document_cancel_requests.doc_key');
    expect(names).toContain('scm.inventory_movements.batch_no');
    expect(names).not.toContain('scm.purchase_orders.id');
    expect(names).not.toContain('scm.unrelated_notes.body');
  });

  test('the sweep finds every child, the audit rows, and a table nobody listed', async () => {
    const swept = await sweepReferences(sql, PO, [LINE_A, LINE_B]);
    expect(swept.failed).toEqual([]);
    expect(Array.isArray(swept.hits)).toBe(true);
    const by = new Map(swept.hits.map((h) => [`${h.table}.${h.column}`, h.n]));
    expect(by.get('scm.purchase_order_items.purchase_order_id')).toBe(2);
    expect(by.get('scm.purchase_order_item_allocations.purchase_order_item_id')).toBe(1);
    expect(by.get('scm.po_amendment_lines.purchase_order_item_id')).toBe(1);
    expect(by.get('scm.po_amendments.po_id')).toBe(1);
    expect(by.get('scm.po_revisions.po_id')).toBe(1);
    expect(by.get('scm.document_cancel_requests.doc_key')).toBe(1);
    // The PO request AND the SO request carry the number; only one is the PO's.
    expect(by.get('scm.document_cancel_requests.doc_number')).toBe(2);
    expect(by.get('scm.autocount_outbox.doc_id')).toBe(2);
    expect(by.get('scm.entity_audit_log.entity_id')).toBe(1);
    // The PO's own row (linked_ac_docno = its number) is not a reference to itself.
    expect([...by.keys()].some((k) => k.startsWith('scm.purchase_orders.'))).toBe(false);
  });

  test('ANOTHER PO carrying this number IS a reference', async () => {
    await sql.unsafe(`UPDATE scm.purchase_orders SET linked_ac_docno = '${PO.po_number}' WHERE id = '${OTHER}'`);
    const hit = (await sweepReferences(sql, PO, [])).hits.find((h) => h.table === 'scm.purchase_orders');
    expect(hit).toEqual({ table: 'scm.purchase_orders', column: 'linked_ac_docno', n: 1 });
  });

  test('a GRN line naming one of the PO lines is found and refuses', async () => {
    await sql.unsafe(`INSERT INTO scm.grn_items (purchase_order_item_id) VALUES ('${LINE_B}')`);
    const hit = (await sweepReferences(sql, PO, [LINE_A, LINE_B])).hits.find((h) => h.table === 'scm.grn_items');
    expect(hit?.n).toBe(1);
    expect(classifyReference('scm.grn_items')).toBe(DOWNSTREAM);
  });

  test('a drop-ship stock OUT on the PO number (batch_no) is found and refuses', async () => {
    await sql.unsafe(`INSERT INTO scm.inventory_movements (movement_type, source_doc_type, batch_no)
                      VALUES ('OUT', 'DO', ' hc-po-2611-001 ')`);
    const hit = (await sweepReferences(sql, PO, [])).hits.find((h) => h.table === 'scm.inventory_movements');
    expect(hit?.column).toBe('batch_no');
    expect(classifyReference('scm.inventory_movements')).toBe(DOWNSTREAM);
  });

  test('an unlisted table refuses as UNCLASSIFIED; a product request refuses as DOWNSTREAM', async () => {
    await sql.unsafe(`INSERT INTO scm.po_supplier_mail_log (purchase_order_id) VALUES ('${PO.id}');
                      INSERT INTO scm.product_requests (po_id) VALUES ('${PO.id}')`);
    const hits = keys(await sweepReferences(sql, PO, []));
    expect(hits).toContain('scm.po_supplier_mail_log.purchase_order_id');
    expect(hits).toContain('scm.product_requests.po_id');
    expect(classifyReference('scm.po_supplier_mail_log')).toBe(UNCLASSIFIED);
    expect(classifyReference('scm.product_requests')).toBe(DOWNSTREAM);
  });

  test('classification: one bucket per table', () => {
    for (const t of CHILD_TABLES) expect(classifyReference(t.table)).toBe(CHILD);
    expect(classifyReference('scm.autocount_outbox')).toBe(AUDIT);
    expect(classifyReference('scm.entity_audit_log')).toBe(AUDIT);
    for (const t of ['scm.grns', 'scm.purchase_invoices', 'scm.purchase_returns',
      'scm.po_receipt_so_assignments', 'scm.delivery_order_items', 'scm.journal_entries']) {
      expect(classifyReference(t)).toBe(DOWNSTREAM);
    }
  });

  test("after the script's own deletes, only the audit trail and the SO request name it", async () => {
    await deleteLikeTheScript(sql);
    expect(keys(await sweepReferences(sql, PO, [LINE_A, LINE_B]))).toEqual([
      'scm.autocount_outbox.ac_doc_no',
      'scm.autocount_outbox.doc_id',
      'scm.autocount_outbox.doc_no',
      'scm.document_cancel_requests.doc_number', // the SO request, left alone
      'scm.entity_audit_log.entity_doc_no',
      'scm.entity_audit_log.entity_id',
    ]);
    const [so] = await sql`SELECT count(*)::int AS n FROM scm.document_cancel_requests WHERE doc_type = 'SO'`;
    expect(so.n).toBe(1);
    // The other PO's line and slice are untouched.
    const [other] = await sql`SELECT count(*)::int AS n FROM scm.purchase_order_item_allocations`;
    expect(other.n).toBe(1);
  });
});

describePg('delete-test-po — is it still live?', () => {
  beforeAll(async () => {
    sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    await schema(sql);
  });
  beforeEach(async () => { await seed(sql); });
  afterAll(async () => { await sql?.end(); });

  const header = async () => (await sql`SELECT * FROM scm.purchase_orders WHERE id = ${PO.id}`)[0];

  test('a DRAFT (or CANCELLED) PO whose AutoCount cancel was sent has no blockers', async () => {
    expect(await poBlockers(sql, await header())).toEqual([]);
    await sql.unsafe(`UPDATE scm.purchase_orders SET status = 'CANCELLED' WHERE id = '${PO.id}'`);
    expect(await poBlockers(sql, await header())).toEqual([]);
  });

  test('SUBMITTED, PARTIALLY_RECEIVED and RECEIVED each block', async () => {
    for (const s of ['SUBMITTED', 'PARTIALLY_RECEIVED', 'RECEIVED']) {
      await sql.unsafe(`UPDATE scm.purchase_orders SET status = '${s}' WHERE id = '${PO.id}'`);
      expect((await poBlockers(sql, await header())).join(' ')).toContain(`status=${s}`);
    }
  });

  test('AutoCount holding the PO with no sent cancel blocks', async () => {
    await sql.unsafe(`DELETE FROM scm.autocount_outbox WHERE op = 'cancel'`);
    expect((await poBlockers(sql, await header())).join(' ')).toContain('no cancel was sent');
  });

  test('a pending or failed outbox row blocks', async () => {
    await sql.unsafe(`INSERT INTO scm.autocount_outbox (op, doc_type, doc_no, doc_id, status)
                      VALUES ('edit', 'PO', '${PO.po_number}', '${PO.id}', 'failed')`);
    expect((await poBlockers(sql, await header())).join(' ')).toContain('edit row still failed');
  });

  test("another PO's outbox rows do not count", async () => {
    await sql.unsafe(`INSERT INTO scm.autocount_outbox (op, doc_type, doc_no, doc_id, status)
                      VALUES ('edit', 'PO', 'HC-PO-2611-002', '${OTHER}', 'pending')`);
    expect(await poBlockers(sql, await header())).toEqual([]);
  });
});

describePg('delete-test-po — the control', () => {
  beforeAll(async () => {
    sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    await schema(sql);
  });
  beforeEach(async () => { await seed(sql); });
  afterAll(async () => { await sql?.end(); });

  const opts = { moneyCol: 'total_sen' };

  test('deleting ONLY this PO leaves the control identical', async () => {
    const before = await controlSnapshot(sql, PO.id, opts);
    expect(before).toMatchObject({ po_rows: 1, item_rows: 1, money_sum: '7000' });
    await deleteLikeTheScript(sql);
    expect(controlDrift(before, await controlSnapshot(sql, PO.id, opts))).toEqual([]);
  });

  test('a status change on ANOTHER PO is caught', async () => {
    const before = await controlSnapshot(sql, PO.id, opts);
    await sql.unsafe(`UPDATE scm.purchase_orders SET status = NULL WHERE id = '${OTHER}'`);
    expect(controlDrift(before, await controlSnapshot(sql, PO.id, opts))).toEqual(['po_fingerprint']);
  });

  test('a line removed from ANOTHER PO is caught', async () => {
    const before = await controlSnapshot(sql, PO.id, opts);
    await sql.unsafe(`DELETE FROM scm.purchase_order_items WHERE id = '${LINE_OTHER}'`);
    expect(controlDrift(before, await controlSnapshot(sql, PO.id, opts))).toEqual(['item_rows']);
  });

  test('a money change on ANOTHER PO is caught; a missing money column is null, not drift', async () => {
    const before = await controlSnapshot(sql, PO.id, opts);
    await sql.unsafe(`UPDATE scm.purchase_orders SET total_sen = total_sen + 1 WHERE id = '${OTHER}'`);
    expect(controlDrift(before, await controlSnapshot(sql, PO.id, opts))).toEqual(['money_sum']);
    const bare = await controlSnapshot(sql, PO.id, { moneyCol: null });
    expect(bare.money_sum).toBeNull();
    expect(controlDrift(bare, bare)).toEqual([]);
  });
});
