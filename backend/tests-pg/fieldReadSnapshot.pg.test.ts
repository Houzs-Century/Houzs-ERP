/* The field read must be ONE SNAPSHOT, and its no-LIMIT assertion must still
 * catch a real cap.
 *
 * WHAT BROKE. The full tally (po-gr-tally-verdict.yml, run 34325417734,
 * 2026-09-09) refused and printed nothing at all:
 *
 *     REFUSED: SO: the field query returned 15258 ERP lines but COUNT(*) says
 *     15264. The answer is being truncated; a count taken from a truncated read
 *     is a lie.
 *
 * The assertion is right to exist and is NOT relaxed here. What was wrong is
 * that its two numbers came from two different snapshots: `loadErpFieldSide`
 * fired seven statements on one autocommit connection, the SO array being
 * statement 2 and the SO count statement 7. Six sales-order lines were written
 * by another lane in the gap. Nothing was truncated; the owner lost the whole
 * verdict to a moving table.
 *
 * WHY THIS SUITE AND NOT A UNIT TEST. The defect IS concurrency, and it cannot
 * be reproduced by a mock or by sleeping — only by a real second connection
 * writing at the one instant that matters. So the reader is `loadErpFieldSide`
 * itself, against real Postgres, with a test seam that fires exactly between
 * the arrays and the counts.
 *
 * PROVEN RED BEFORE IT WAS PROVEN GREEN. `reproduces the old autocommit read`
 * below runs the SAME two statements the old way, with the SAME interleaved
 * write, and asserts they DISAGREE — 10 rows against a count of 16. If some
 * later change makes that control pass, this file has stopped testing anything
 * and says so. And `a genuine cap still disagrees` proves REPEATABLE READ did
 * not paper over the failure the assertion was written for: a capped read
 * inside one snapshot is still short, and still refuses.
 *
 * SKIPPED, not failed, without TEST_DATABASE_URL, matching the other pg suites.
 */
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { loadErpFieldSide } from '../scripts/lib/ac-field-identity-run.mjs';

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const CO = 1;

/* Only the columns the reader's SQL actually names without a `pick` guard.
   `pick`/`pickI` degrade an absent column to `NULL AS <name>`, so a lean
   fixture exercises the same statements a full production row would; what a
   missing column here would break is the JOIN shape, which is the point. */
async function schema(db: Sql) {
  await db.unsafe('DROP SCHEMA IF EXISTS scm CASCADE');
  await db.unsafe('CREATE SCHEMA scm');
  await db.unsafe(`
    CREATE TABLE scm.mfg_sales_orders (
      doc_no text PRIMARY KEY, company_id int NOT NULL, linked_ac_docno text);
    CREATE TABLE scm.mfg_sales_order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      doc_no text NOT NULL, line_no int, qty int NOT NULL DEFAULT 1);

    CREATE TABLE scm.suppliers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text, name text);
    CREATE TABLE scm.warehouses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text);
    CREATE TABLE scm.purchase_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), po_number text, company_id int NOT NULL,
      linked_ac_docno text, supplier_id uuid, purchase_location_id uuid);
    CREATE TABLE scm.purchase_order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), purchase_order_id uuid NOT NULL,
      qty int NOT NULL DEFAULT 1, received_qty int NOT NULL DEFAULT 0);

    CREATE TABLE scm.delivery_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), do_number text, company_id int NOT NULL,
      linked_ac_docno text, so_doc_no text);
    CREATE TABLE scm.delivery_order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), delivery_order_id uuid NOT NULL,
      line_no int, qty int NOT NULL DEFAULT 1);
  `);
}

/* Two in-scope sales orders carrying ten lines between them. The numbers are
   small on purpose: the defect is about WHICH ROWS ARE VISIBLE TO WHICH
   STATEMENT, and 10 against 16 reads as plainly as 15258 against 15264. */
const SEEDED = 10;

async function seed(db: Sql) {
  await db.unsafe(`
    TRUNCATE scm.mfg_sales_order_items, scm.mfg_sales_orders,
             scm.purchase_order_items, scm.purchase_orders,
             scm.delivery_order_items, scm.delivery_orders;
    INSERT INTO scm.mfg_sales_orders (doc_no, company_id, linked_ac_docno)
      VALUES ('HC-SO-000001', 1, 'SO-000001'), ('HC-SO-000002', 1, 'SO-000002');
    INSERT INTO scm.mfg_sales_order_items (doc_no, line_no, qty)
      SELECT 'HC-SO-000001', g, 1 FROM generate_series(1, 6) g;
    INSERT INTO scm.mfg_sales_order_items (doc_no, line_no, qty)
      SELECT 'HC-SO-000002', g, 1 FROM generate_series(1, 4) g;
  `);
}

/* The interfering lane. A SECOND connection, so it is a genuinely concurrent
   committed write and not this transaction seeing its own rows. Six, the number
   that actually landed during run 34325417734. */
const INTERFERING = 6;

async function anotherLaneWrites(other: Sql) {
  await other.unsafe(`
    INSERT INTO scm.mfg_sales_order_items (doc_no, line_no, qty)
      SELECT 'HC-SO-000001', 100 + g, 1 FROM generate_series(1, ${INTERFERING}) g;
  `);
}

describePg('the ERP field read is one snapshot', () => {
  let sql: Sql;
  let other: Sql;

  beforeAll(async () => {
    sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    other = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    await schema(sql);
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await other?.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await seed(sql);
  });

  test('a write landing between the rows and the count cannot move the count', async () => {
    const erp = await loadErpFieldSide(sql, CO, {
      betweenReadsForTest: () => anotherLaneWrites(other),
    });

    /* This is the assertion check-ac-erp-reconcile.mjs makes before it refuses.
       Passing it is what lets the tally print at all. */
    expect(erp.SO.lines.length).toBe(erp.lineCounts.SO);
    /* And the snapshot is the one the read STARTED on, not a later one: the six
       interfering rows are in neither number. */
    expect(erp.SO.lines.length).toBe(SEEDED);
    expect(erp.lineCounts.SO).toBe(SEEDED);
  });

  test('the interfering write really did commit — otherwise this suite proves nothing', async () => {
    await loadErpFieldSide(sql, CO, { betweenReadsForTest: () => anotherLaneWrites(other) });
    const [{ n }] = await sql.unsafe(
      `SELECT COUNT(*)::int AS n FROM scm.mfg_sales_order_items i
         JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
        WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
    );
    expect(n).toBe(SEEDED + INTERFERING);
  });

  test('reproduces the old autocommit read: the SAME two statements DISAGREE', async () => {
    /* The red state, kept executable. These are the reader's own SO statements
       run the way they were run before the fix — each on its own snapshot, with
       the same interleaved write — and they disagree by exactly the six rows
       that were written in between. If this ever passes as "agree", the test
       above has stopped being evidence of anything. */
    const from =
      'scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no ' +
      `WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`;

    const rows = await sql.unsafe(`SELECT i.id FROM ${from}`);
    await anotherLaneWrites(other);
    const [{ n }] = await sql.unsafe(`SELECT COUNT(*)::int AS n FROM ${from}`);

    expect(rows.length).toBe(SEEDED);
    expect(n).toBe(SEEDED + INTERFERING);
    expect(rows.length).not.toBe(n); // ← the refusal, reproduced
  });

  test('a genuine cap still disagrees inside one snapshot — the guard is not weakened', async () => {
    /* The failure the assertion was written for: a LIMIT that quietly shortens
       the answer. One snapshot does not hide it, so the tally still refuses. */
    await sql.begin('read only isolation level repeatable read', async (tx) => {
      const from =
        'scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no ' +
        `WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`;
      const capped = await tx.unsafe(`SELECT i.id FROM ${from} LIMIT 4`);
      const [{ n }] = await tx.unsafe(`SELECT COUNT(*)::int AS n FROM ${from}`);
      expect(capped.length).toBe(4);
      expect(n).toBe(SEEDED);
      expect(capped.length).not.toBe(n);
    });
  });

  test('the mode string really applied: repeatable read, and read only', async () => {
    /* postgres.js strips the transaction-mode string with a regex before
       sending it, so a typo does not error — it silently gives you a plain READ
       COMMITTED transaction that behaves exactly like the bug. Asked from
       INSIDE the reader's own block, so what is asserted is the string the
       production code ships, not one retyped here. */
    let isolation = '';
    let readOnly = '';
    await loadErpFieldSide(sql, CO, {
      betweenReadsForTest: async (tx: Sql) => {
        const [row] = await tx.unsafe(
          `SELECT current_setting('transaction_isolation') AS iso,
                  current_setting('transaction_read_only') AS ro`,
        );
        isolation = String(row.iso);
        readOnly = String(row.ro);
      },
    });

    /* REPEATABLE READ is what pins one snapshot across the seven statements —
       without it the fix is decoration. READ ONLY = on is the server's own
       promise that this diagnostic cannot write to production. */
    expect(isolation).toBe('repeatable read');
    expect(readOnly).toBe('on');
  });
});
