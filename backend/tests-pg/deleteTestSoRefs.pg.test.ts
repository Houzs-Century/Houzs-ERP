/* EXECUTES the SQL behind `scripts/delete-test-so.mjs` against real Postgres —
 * the reference sweep that decides whether a delete is safe, and the control
 * that decides whether anything ELSE moved.
 *
 * WHY THIS EXISTS, precisely. `delete-test-so.mjs` opens a database in its first
 * ten lines, so there is no local run of it: before this suite, `node --check`
 * was the entire body of evidence a DELETE against production had. Two of this
 * repo's own incidents say that is not enough — `probe-undated-demand.mjs` died
 * mid-dispatch on SQL only Postgres could reject (run 31962771658), and
 * `set-write-freeze.mjs` died on its first dispatch because a shared helper
 * returned a Set where the caller passed an array
 * (docs/bugs/0711, run 34209796675). Neither was reachable by any check that
 * stops short of opening a database. This one opens one.
 *
 * THE TWO ASSERTIONS THAT MATTER, and both are proved in BOTH directions:
 *
 *  · the sweep finds a reference the hand-written CHILD_TABLES list does not
 *    know about — because that list HAS been incomplete, and a sweep that only
 *    ever agrees with it would be decoration;
 *  · the control DETECTS a change to another order. A control that always
 *    answers "nothing moved" is the same as no control, so the drift is proved
 *    RED against a mutated row before it is trusted GREEN.
 *
 * SKIPPED, not failed, without TEST_DATABASE_URL, matching the other pg suites.
 */
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  AUDIT, AUDIT_KEEP, CHILD, DOWNSTREAM, UNCLASSIFIED,
  CONTROL_FIELDS, classifyReference, controlDrift, controlSnapshot,
  referenceColumns, sweepReferences,
} from '../scripts/lib/delete-test-so-refs.mjs';

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

let sql: Sql;

const DOC = 'HC-SO-2609-001';

/* The tables `delete-test-so.mjs` names, plus three the sweep has to find on its
   own: scm.so_revisions (a CHILD nobody listed), scm.autocount_outbox (AUDIT,
   kept on purpose) and scm.delivery_orders (DOWNSTREAM, refuses). A column with
   no doc-no in its NAME is included too, to prove the sweep's filter is a filter
   and not a full-table crawl. */
async function schema(db: Sql) {
  await db.unsafe(`
    DROP SCHEMA IF EXISTS scm CASCADE;
    CREATE SCHEMA scm;

    /* status is an ENUM in production, not text, and declaring it as text here
       is what let coalesce(status, '') reach production and fail there
       (run 34223295235, plan mode). Values copied from
       backend/scripts/scm-schema/2990s-full-schema.sql:16. */
    CREATE TYPE scm.mfg_so_status AS ENUM (
      'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED',
      'INVOICED', 'CLOSED', 'ON_HOLD', 'CANCELLED'
    );

    CREATE TABLE scm.mfg_sales_orders (
      doc_no text PRIMARY KEY, status scm.mfg_so_status, company_id int, total_sen bigint,
      -- The book's number for this order. When AutoCount takes OUR number the
      -- two are equal, which is the case that made the sweep report the row
      -- being deleted as a reference to itself (run 34220446297).
      linked_ac_docno text
    );
    CREATE TABLE scm.mfg_sales_order_items (
      id serial PRIMARY KEY, doc_no text, item_code text, qty numeric, variants jsonb
    );
    CREATE TABLE scm.mfg_sales_order_payments (
      id serial PRIMARY KEY, so_doc_no text, amount_sen bigint
    );
    CREATE TABLE scm.mfg_sales_order_activity (
      id serial PRIMARY KEY, doc_no text, action text
    );
    CREATE TABLE scm.so_amendments (
      id serial PRIMARY KEY, so_doc_no text
    );
    -- NOT in CHILD_TABLES. The sweep has to find this by itself.
    CREATE TABLE scm.so_revisions (
      id serial PRIMARY KEY, doc_no text, rev int
    );
    -- The sales-order audit log. Append-only, survives the delete on purpose,
    -- and on NO list at all until the sweep found it.
    CREATE TABLE scm.mfg_so_audit_log (
      id serial PRIMARY KEY, so_doc_no text, action text, actor_name_snapshot text
    );
    -- Append-only. Survives the delete on purpose.
    CREATE TABLE scm.autocount_outbox (
      id serial PRIMARY KEY, doc_no text, op text, status text, ac_doc_no text
    );
    -- A real downstream document. A hit here refuses the run.
    CREATE TABLE scm.delivery_orders (
      id serial PRIMARY KEY, do_number text, so_doc_no text
    );
    -- No doc-no in the column name: must never be scanned.
    CREATE TABLE scm.unrelated_notes (
      id serial PRIMARY KEY, body text
    );
  `);
}

async function seed(db: Sql) {
  await db.unsafe(`
    TRUNCATE scm.mfg_sales_orders, scm.mfg_sales_order_items, scm.mfg_sales_order_payments,
             scm.mfg_sales_order_activity, scm.so_amendments, scm.so_revisions,
             scm.autocount_outbox, scm.delivery_orders, scm.unrelated_notes,
             scm.mfg_so_audit_log;

    -- HC-SO-2609-001 carries its OWN number as the book number, exactly as
    -- production does after a successful write-back.
    INSERT INTO scm.mfg_sales_orders (doc_no, status, company_id, total_sen, linked_ac_docno) VALUES
      ('HC-SO-2609-001', 'CONFIRMED', 1, 100000, 'HC-SO-2609-001'),
      ('HC-SO-013361',   'CONFIRMED', 1, 250000, 'SO-013361'),
      -- NOT 'DRAFT'. The enum above has no DRAFT and neither does the schema
      -- dump it was copied from, so seeding one made every test in this file
      -- die in the fixture with: invalid input value for enum
      -- scm.mfg_so_status: "DRAFT"  (run 34224696391) -- 17 red tests, one
      -- wrong word, and none of the failures were about what they tested.
      -- Which value this row carries is incidental: line 270 nulls it and line
      -- 306 deletes it. It only has to be VALID and not CONFIRMED.
      --
      -- Worth knowing, and deliberately NOT changed here: this repo holds two
      -- copies of the enum and they DISAGREE.
      --   backend/scripts/scm-schema/2990s-full-schema.sql:16   no DRAFT
      --   backend/scripts/scale-pg-real-schema.mjs:48           HAS DRAFT
      -- One rule, two copies is a recurring defect class here. Which one
      -- matches production is unmeasured -- resolving it needs a read of the
      -- live type, not a guess, and it is not this PR's job.
      ('HC-SO-013362',   'ON_HOLD',   1,  70000, NULL);

    INSERT INTO scm.mfg_so_audit_log (so_doc_no, action, actor_name_snapshot)
      VALUES ('HC-SO-2609-001', 'CREATE', 'Lim');

    INSERT INTO scm.mfg_sales_order_items (doc_no, item_code, qty, variants) VALUES
      ('HC-SO-2609-001', 'SOFA-A', 1, '{"colour":"BEIGE"}'),
      ('HC-SO-2609-001', 'SOFA-B', 2, '{"colour":"GREY"}'),
      ('HC-SO-013361',   'SOFA-C', 1, '{}');

    INSERT INTO scm.mfg_sales_order_payments (so_doc_no, amount_sen) VALUES
      ('HC-SO-2609-001', 100000),
      ('HC-SO-013361',    50000);

    INSERT INTO scm.mfg_sales_order_activity (doc_no, action) VALUES ('HC-SO-2609-001', 'CREATE');
    INSERT INTO scm.so_revisions (doc_no, rev) VALUES ('HC-SO-2609-001', 1);
    INSERT INTO scm.autocount_outbox (doc_no, op, status, ac_doc_no)
      VALUES ('HC-SO-2609-001', 'create_so', 'SENT', 'HC-SO-2609-001');
    INSERT INTO scm.unrelated_notes (body) VALUES ('HC-SO-2609-001 mentioned in prose');
  `);
}

describePg('delete-test-so — the reference sweep, against real Postgres', () => {
  beforeAll(async () => {
    sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    await schema(sql);
  });
  beforeEach(async () => { await seed(sql); });
  afterAll(async () => { await sql?.end(); });

  test('the candidate columns are the doc-no columns, and NOT the parent key or free text', async () => {
    const cols = await referenceColumns(sql);
    const names = cols.map((c) => `${c.schema}.${c.table}.${c.column}`);

    // The parent's own key is a candidate here; the SWEEP is what excludes it.
    expect(names).toContain('scm.mfg_sales_orders.doc_no');
    expect(names).toContain('scm.so_revisions.doc_no');
    expect(names).toContain('scm.mfg_sales_order_payments.so_doc_no');
    // A text column with no doc-no in its name is never counted.
    expect(names).not.toContain('scm.unrelated_notes.body');
  });

  test('the sweep counts every reference — including one CHILD_TABLES never listed', async () => {
    const swept = await sweepReferences(sql, DOC);

    expect(swept.failed).toEqual([]);
    // docs/bugs/0711: the shape of what a helper returns is invisible until it
    // is called. `hits` is an ARRAY, and this is where that is settled.
    expect(Array.isArray(swept.hits)).toBe(true);
    expect(swept.scanned).toBeGreaterThan(0);

    const byTable = new Map(swept.hits.map((h) => [`${h.table}.${h.column}`, h.n]));
    expect(byTable.get('scm.mfg_sales_order_items.doc_no')).toBe(2);
    expect(byTable.get('scm.mfg_sales_order_payments.so_doc_no')).toBe(1);
    expect(byTable.get('scm.mfg_sales_order_activity.doc_no')).toBe(1);
    expect(byTable.get('scm.autocount_outbox.doc_no')).toBe(1);
    // The one nobody listed. This is the finding the sweep exists for.
    expect(byTable.get('scm.so_revisions.doc_no')).toBe(1);
    // The row being deleted is not a reference to itself.
    expect(byTable.has('scm.mfg_sales_orders.doc_no')).toBe(false);
    // Nothing points at it from a table with no rows for it.
    expect(byTable.has('scm.so_amendments.so_doc_no')).toBe(false);
  });

  /* PROVED RED against the first draft of the sweep, which excluded the parent
     table by COLUMN and therefore reported the deleted row's own
     linked_ac_docno as an unclassified reference (run 34220446297). */
  test("the order's OWN book number is not a reference to itself", async () => {
    const swept = await sweepReferences(sql, DOC);
    expect(swept.hits.some((h) => h.table === 'scm.mfg_sales_orders')).toBe(false);
  });

  /* And the repair must not go too far the other way. Excluding the COLUMN
     would silence this row, which is a genuine and dangerous reference. */
  test('ANOTHER order carrying this number as its book number IS a reference', async () => {
    await sql.unsafe(
      `UPDATE scm.mfg_sales_orders SET linked_ac_docno = '${DOC}' WHERE doc_no = 'HC-SO-013362'`);
    const swept = await sweepReferences(sql, DOC);
    const hit = swept.hits.find((h) => h.table === 'scm.mfg_sales_orders');
    expect(hit?.column).toBe('linked_ac_docno');
    expect(hit?.n).toBe(1);
  });

  test('the sales-order audit log is found, and it is KEPT, not deleted', async () => {
    const swept = await sweepReferences(sql, DOC);
    const hit = swept.hits.find((h) => h.table === 'scm.mfg_so_audit_log');
    expect(hit?.n).toBe(1);
    // Who created the order outlives the order. That is the point.
    expect(classifyReference('scm.mfg_so_audit_log', new Set())).toBe(AUDIT);
  });

  test('a reference is matched trimmed and case-folded, the way the register does', async () => {
    await sql.unsafe(`INSERT INTO scm.so_revisions (doc_no, rev) VALUES ('  hc-so-2609-001 ', 2)`);
    const swept = await sweepReferences(sql, '  HC-SO-2609-001  ');
    const hit = swept.hits.find((h) => h.table === 'scm.so_revisions');
    expect(hit?.n).toBe(2);
  });

  test('a downstream delivery order is FOUND and classified as refusing', async () => {
    await sql.unsafe(`INSERT INTO scm.delivery_orders (do_number, so_doc_no) VALUES ('HC-DO-1', '${DOC}')`);
    const swept = await sweepReferences(sql, DOC);
    const hit = swept.hits.find((h) => h.table === 'scm.delivery_orders');
    expect(hit?.n).toBe(1);
    expect(classifyReference('scm.delivery_orders', new Set())).toBe(DOWNSTREAM);
  });

  test('classification puts each table in exactly one bucket', () => {
    const children = new Set([
      'scm.mfg_sales_order_items', 'scm.mfg_sales_order_payments',
      'scm.mfg_sales_order_activity', 'scm.so_amendments',
    ]);
    expect(classifyReference('scm.mfg_sales_order_items', children)).toBe(CHILD);
    expect(classifyReference('scm.autocount_outbox', children)).toBe(AUDIT);
    expect(classifyReference('scm.delivery_orders', children)).toBe(DOWNSTREAM);
    expect(classifyReference('scm.so_revisions', children)).toBe(UNCLASSIFIED);
    // The audit list is what keeps the ERP's own record of the write-back.
    expect(AUDIT_KEEP.has('scm.autocount_outbox')).toBe(true);
  });

  test('nothing names the document once it and its children are gone, except the audit row', async () => {
    await sql.unsafe(`DELETE FROM scm.mfg_sales_order_items    WHERE doc_no    = '${DOC}'`);
    await sql.unsafe(`DELETE FROM scm.mfg_sales_order_payments WHERE so_doc_no = '${DOC}'`);
    await sql.unsafe(`DELETE FROM scm.mfg_sales_order_activity WHERE doc_no    = '${DOC}'`);
    await sql.unsafe(`DELETE FROM scm.so_revisions             WHERE doc_no    = '${DOC}'`);
    await sql.unsafe(`DELETE FROM scm.mfg_sales_orders         WHERE doc_no    = '${DOC}'`);

    const swept = await sweepReferences(sql, DOC);
    /* A hit is one (table, COLUMN) pair, not one table — scm.autocount_outbox
       carries the number in BOTH doc_no and ac_doc_no and answers twice, which
       is what production prints as well (run 34220446297). */
    expect(swept.hits.map((h) => `${h.table}.${h.column}`).sort()).toEqual([
      'scm.autocount_outbox.ac_doc_no',
      'scm.autocount_outbox.doc_no',
      'scm.mfg_so_audit_log.so_doc_no',
    ]);
    // And every survivor is one somebody decided to keep.
    for (const h of swept.hits) expect(AUDIT_KEEP.has(h.table)).toBe(true);
  });
});

describePg('delete-test-so — the control, against real Postgres', () => {
  beforeAll(async () => {
    sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    await schema(sql);
  });
  beforeEach(async () => { await seed(sql); });
  afterAll(async () => { await sql?.end(); });

  const opts = { moneyCol: 'total_sen', payCol: 'so_doc_no' };

  /* PROVED RED: with `status` declared as the real enum, the pre-fix
     `coalesce(status, '')` raises
     `invalid input value for enum scm.mfg_so_status: ""` here instead of in
     production. A NULL status is the case that reaches the coalesce at all. */
  test('a NULL status does not break the fingerprint — status is an enum, not text', async () => {
    await sql.unsafe(`UPDATE scm.mfg_sales_orders SET status = NULL WHERE doc_no = 'HC-SO-013362'`);
    const snap = await controlSnapshot(sql, DOC, opts);
    expect(String(snap.so_fingerprint)).toMatch(/^[0-9a-f]{32}$/);
    expect(snap.so_rows).toBe(2);
  });

  test('it reads every field it promises', async () => {
    const snap = await controlSnapshot(sql, DOC, opts);
    for (const f of CONTROL_FIELDS) expect(snap).toHaveProperty(f);
    // Two OTHER orders, one other line, one other payment.
    expect(snap.so_rows).toBe(2);
    expect(snap.item_rows).toBe(1);
    expect(snap.pay_rows).toBe(1);
    expect(String(snap.money_sum)).toBe('320000');
    expect(String(snap.so_fingerprint)).toMatch(/^[0-9a-f]{32}$/);
  });

  test('deleting ONLY the named document leaves the control identical', async () => {
    const before = await controlSnapshot(sql, DOC, opts);
    await sql.unsafe(`DELETE FROM scm.mfg_sales_order_items    WHERE doc_no    = '${DOC}'`);
    await sql.unsafe(`DELETE FROM scm.mfg_sales_order_payments WHERE so_doc_no = '${DOC}'`);
    await sql.unsafe(`DELETE FROM scm.mfg_sales_orders         WHERE doc_no    = '${DOC}'`);
    const after = await controlSnapshot(sql, DOC, opts);
    expect(controlDrift(before, after)).toEqual([]);
  });

  /* PROVED RED. A control that cannot see a change is not a control, so each of
     the four ways another document could move is made to move, one at a time. */
  test('a status change on ANOTHER order is caught by the fingerprint', async () => {
    const before = await controlSnapshot(sql, DOC, opts);
    await sql.unsafe(`UPDATE scm.mfg_sales_orders SET status = 'CANCELLED' WHERE doc_no = 'HC-SO-013361'`);
    expect(controlDrift(before, await controlSnapshot(sql, DOC, opts))).toEqual(['so_fingerprint']);
  });

  test('a deleted OTHER order is caught by the row count and the fingerprint', async () => {
    const before = await controlSnapshot(sql, DOC, opts);
    await sql.unsafe(`DELETE FROM scm.mfg_sales_orders WHERE doc_no = 'HC-SO-013362'`);
    const drift = controlDrift(before, await controlSnapshot(sql, DOC, opts));
    expect(drift).toContain('so_rows');
    expect(drift).toContain('so_fingerprint');
    expect(drift).toContain('money_sum');
  });

  test("a line deleted from ANOTHER order is caught", async () => {
    const before = await controlSnapshot(sql, DOC, opts);
    await sql.unsafe(`DELETE FROM scm.mfg_sales_order_items WHERE doc_no = 'HC-SO-013361'`);
    expect(controlDrift(before, await controlSnapshot(sql, DOC, opts))).toEqual(['item_rows']);
  });

  test("a payment touched on ANOTHER order is caught", async () => {
    const before = await controlSnapshot(sql, DOC, opts);
    await sql.unsafe(`DELETE FROM scm.mfg_sales_order_payments WHERE so_doc_no = 'HC-SO-013361'`);
    expect(controlDrift(before, await controlSnapshot(sql, DOC, opts))).toEqual(['pay_rows']);
  });

  test('a money change on ANOTHER order is caught', async () => {
    const before = await controlSnapshot(sql, DOC, opts);
    await sql.unsafe(`UPDATE scm.mfg_sales_orders SET total_sen = total_sen + 1 WHERE doc_no = 'HC-SO-013361'`);
    expect(controlDrift(before, await controlSnapshot(sql, DOC, opts))).toEqual(['money_sum']);
  });

  test('a column that is not in the schema yields null, never a wrong number', async () => {
    const snap = await controlSnapshot(sql, DOC, { moneyCol: null, payCol: null });
    expect(snap.money_sum).toBeNull();
    expect(snap.pay_rows).toBeNull();
    // And null on both sides must not read as drift.
    expect(controlDrift(snap, snap)).toEqual([]);
  });
});
