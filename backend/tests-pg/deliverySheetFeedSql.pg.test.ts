/* EXECUTES the HC Delivery sheet feed's SQL (src/lib/delivery-sheet-feed.ts)
 * against real Postgres. The statements lean on Postgres-only shapes —
 * `GREATEST` over three timestamps, `string_agg ... FILTER`, `?2::timestamptz`,
 * `RETURNING` — that the workers suite's D1 cannot parse, so without this file
 * their first contact with a Postgres parser would be production, at the
 * sheet's next 15-minute pull.
 *
 * Asserted: the page is the secret's company only, DRAFT/CANCELLED never
 * appear, a payment or a delivery order newer than the header MOVES the row's
 * LastModified (116 live orders had exactly that on 2026-09-15), the checkpoint
 * is strict so a page never re-sends its last row, cancelled DOs and POs are not
 * named, and the write leg finds a migrated order by its AutoCount number,
 * keeps whichever column the sheet did not send, and moves the order forward
 * so the next pull carries it.
 *
 * SKIPPED, not failed, without TEST_DATABASE_URL, matching the other pg suites.
 */
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { toPgPlaceholders } from '../src/db/d1-compat';
import {
  FEED_BALANCE_COLLECTION_SQL,
  FEED_EPOCH,
  FEED_OVERDUE_SQL,
  FEED_SINCE_SQL,
  feedLinesSql,
  updateFromSheetSql,
  toSheetRecord,
  type FeedHeadRow,
  type FeedLineRow,
} from '../src/lib/delivery-sheet-feed';

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

let sql: Sql;

const SP1 = '11111111-1111-4111-8111-111111111111';
const ITEM1 = '22222222-2222-4222-8222-222222222222';
const PO_LIVE = '33333333-3333-4333-8333-333333333333';
const PO_DEAD = '44444444-4444-4444-8444-444444444444';

async function resetFixture(s: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') {
    throw new Error('PG integration tests require the disposable houzs_test database');
  }
  await s.unsafe(`
    CREATE SCHEMA IF NOT EXISTS scm;
    DROP VIEW IF EXISTS scm.mfg_sales_orders_with_payment_totals CASCADE;
    DROP TABLE IF EXISTS scm.purchase_order_items CASCADE;
    DROP TABLE IF EXISTS scm.purchase_orders CASCADE;
    DROP TABLE IF EXISTS scm.mfg_sales_order_items CASCADE;
    DROP TABLE IF EXISTS scm.delivery_orders CASCADE;
    DROP TABLE IF EXISTS scm.mfg_sales_order_payments CASCADE;
    DROP TABLE IF EXISTS scm.staff CASCADE;
    DROP TABLE IF EXISTS scm.mfg_sales_orders CASCADE;
    CREATE TABLE scm.staff (id uuid PRIMARY KEY, name text);
    CREATE TABLE scm.mfg_sales_orders (
      doc_no text PRIMARY KEY, linked_ac_docno text, company_id bigint NOT NULL,
      so_date date NOT NULL DEFAULT now(), ref text, branding text, debtor_name text NOT NULL, phone text,
      sales_location text, agent text, salesperson_id uuid,
      local_total_sen integer NOT NULL DEFAULT 0,
      remark2 text, remark3 text, remark4 text, note text,
      processing_date date, customer_delivery_date date,
      address1 text, address2 text, address3 text, address4 text, postcode text, city text, customer_state text,
      venue text,
      status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE scm.mfg_sales_order_payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), so_doc_no text NOT NULL, amount_sen integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE scm.delivery_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), do_number text NOT NULL, so_doc_no text, status text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE scm.mfg_sales_order_items (
      id uuid PRIMARY KEY, doc_no text NOT NULL, item_group text, item_code text, stock_status text NOT NULL DEFAULT 'PENDING',
      cancelled boolean DEFAULT false
    );
    CREATE TABLE scm.purchase_orders (id uuid PRIMARY KEY, po_number text, status text NOT NULL, cancelled_at timestamptz);
    CREATE TABLE scm.purchase_order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), purchase_order_id uuid NOT NULL, so_item_id uuid);

    INSERT INTO scm.staff VALUES ('${SP1}', 'Lim Yau Wei');
    INSERT INTO scm.mfg_sales_orders
      (doc_no, linked_ac_docno, company_id, so_date, ref, branding, debtor_name, phone, sales_location, agent, salesperson_id,
       local_total_sen, remark2, status, updated_at, postcode, city, customer_state, address3)
    VALUES
      ('HC-SO-013495', 'SO-013495', 1, '2026-08-20', 'HC12481', 'AKEMI', 'Wendy', '60127712155', 'KL WAREHOUSE', '', '${SP1}',
       500000, NULL, 'CONFIRMED', '2026-09-01 00:00:00+00', '43300', 'Seri Kembangan', 'Selangor', NULL),
      ('HC-SO-2609-078', 'HC-SO-2609-078', 1, '2026-09-02', NULL, 'NONE', 'Dickson', '6582888243', 'SRW WAREHOUSE', 'SALLY', NULL,
       300000, 'READY (PARTIAL)', 'DELIVERED', '2026-09-02 00:00:00+00', NULL, NULL, NULL, 'SINGAPORE 123456'),
      ('HC-SO-000001', 'SO-000001', 1, '2026-09-03', NULL, NULL, 'Draft', NULL, 'KL WAREHOUSE', NULL, NULL,
       100, NULL, 'DRAFT', '2026-09-09 00:00:00+00', NULL, NULL, NULL, NULL),
      ('HC-SO-000002', 'SO-000002', 1, '2026-09-03', NULL, NULL, 'Cancelled', NULL, 'KL WAREHOUSE', NULL, NULL,
       100, NULL, 'CANCELLED', '2026-09-09 00:00:00+00', NULL, NULL, NULL, NULL),
      ('2990-SO-2609-001', NULL, 2, '2026-09-03', NULL, NULL, 'Other company', NULL, 'KL WAREHOUSE', NULL, NULL,
       100, NULL, 'CONFIRMED', '2026-09-10 00:00:00+00', NULL, NULL, NULL, NULL);
    -- Phase-2 fixture: an overdue undelivered order, a delivered-but-owing
    -- order, a delivered-and-paid one and an overdue one in the other company.
    -- All dated 2026-07 on updated_at so the since-feed tests above keep their
    -- order (they read from the epoch and assert who comes after whom).
    INSERT INTO scm.mfg_sales_orders
      (doc_no, linked_ac_docno, company_id, so_date, debtor_name, sales_location, local_total_sen, status, updated_at, customer_delivery_date, venue)
    VALUES
      ('HC-SO-000010', 'SO-000010', 1, '2026-01-02', 'Late', 'PG WAREHOUSE', 100000, 'CONFIRMED', '2026-07-01 00:00:00+00', '2026-01-05', 'PG Showroom'),
      ('HC-SO-000011', 'SO-000011', 1, '2026-01-03', 'Owes', 'KL WAREHOUSE', 100000, 'DELIVERED', '2026-07-02 00:00:00+00', '2026-02-01', NULL),
      ('HC-SO-000012', 'SO-000012', 1, '2026-01-04', 'Paid', 'KL WAREHOUSE', 100000, 'DELIVERED', '2026-07-03 00:00:00+00', '2026-02-02', NULL),
      ('2990-SO-000013', NULL, 2, '2026-01-04', 'Other late', 'KL WAREHOUSE', 100000, 'CONFIRMED', '2026-07-04 00:00:00+00', '2026-01-05', NULL);
    INSERT INTO scm.mfg_sales_order_payments (so_doc_no, amount_sen, created_at)
      VALUES ('HC-SO-013495', 200000, '2026-09-05 10:00:00+00'),
             ('HC-SO-000011', 40000, '2026-07-02 00:00:00+00'),
             ('HC-SO-000012', 100000, '2026-07-03 00:00:00+00');
    INSERT INTO scm.delivery_orders (do_number, so_doc_no, status, updated_at) VALUES
      ('HC-DO-2609-001', 'HC-SO-013495', 'LOADED', '2026-09-03 00:00:00+00'),
      ('HC-DO-2609-002', 'HC-SO-013495', 'CANCELLED', '2026-09-06 00:00:00+00');
    INSERT INTO scm.mfg_sales_order_items (id, doc_no, item_group, item_code, stock_status) VALUES
      ('${ITEM1}', 'HC-SO-013495', 'MATTRESS', 'M1', 'READY');
    INSERT INTO scm.purchase_orders VALUES
      ('${PO_LIVE}', 'PO-2609-001', 'SUBMITTED', NULL),
      ('${PO_DEAD}', 'PO-2609-002', 'CANCELLED', '2026-09-04 00:00:00+00');
    INSERT INTO scm.purchase_order_items (purchase_order_id, so_item_id) VALUES
      ('${PO_LIVE}', '${ITEM1}'), ('${PO_DEAD}', '${ITEM1}');
  `);
}

async function page(company: number, since: string, limit: number): Promise<FeedHeadRow[]> {
  return (await sql.unsafe(toPgPlaceholders(FEED_SINCE_SQL), [company, since, limit] as never[])) as unknown as FeedHeadRow[];
}

describePg('HC Delivery sheet feed SQL — real Postgres', () => {
  beforeAll(async () => {
    // Same int8 → number parsing as src/db/pg.ts, so `balance_sen_live`
    // (integer minus a bigint SUM) lands as a number here as in the Worker.
    sql = postgres(url, {
      max: 1,
      prepare: false,
      types: { bigint: { to: 20, from: [20], parse: (x: string) => Number(x), serialize: (x: number | string) => String(x) } },
    });
    await resetFixture(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  const byDoc = (rows: FeedHeadRow[], doc: string) => rows.find((r) => r.doc_no === doc)!;

  test('from the epoch: the company\'s live orders only, oldest change first, one row each', async () => {
    const rows = await page(1, FEED_EPOCH, 10);
    expect(rows.map((r) => r.doc_no)).toEqual(['HC-SO-000010', 'HC-SO-000011', 'HC-SO-000012', 'HC-SO-2609-078', 'HC-SO-013495']);
    expect(rows.every((r) => typeof r.last_modified_text === 'string')).toBe(true);
    expect(await page(2, FEED_EPOCH, 10)).toHaveLength(2);
  });

  test('a payment and a delivery order newer than the header move LastModified; the cancelled DO is not named', async () => {
    const so = byDoc(await page(1, FEED_EPOCH, 10), 'HC-SO-013495');
    // header 09-01, payment 09-05, cancelled DO touched 09-06 → 09-06
    expect(so!.last_modified_text.startsWith('2026-09-06')).toBe(true);
    expect(so!.balance_sen_live).toBe(300000);
    expect(so!.do_numbers).toBe('HC-DO-2609-001');
    expect(so!.po_numbers).toBe('PO-2609-001');
    expect(so!.salesperson_name).toBe('Lim Yau Wei');
    expect(so!.so_date).toBe('2026-08-20');
  });

  test('the checkpoint is strict — a page never re-sends its own last row', async () => {
    const all = await page(1, FEED_EPOCH, 10);
    const afterSg = await page(1, byDoc(all, 'HC-SO-2609-078').last_modified_text, 10);
    expect(afterSg.map((r) => r.doc_no)).toEqual(['HC-SO-013495']);
    expect(await page(1, byDoc(all, 'HC-SO-013495').last_modified_text, 10)).toHaveLength(0);
    // The old script's checkpoint format still parses.
    expect(await page(1, '2026-09-02 00:00:00', 10)).toHaveLength(1);
  });

  test('overdue: undelivered orders past their delivery date, this company only, oldest first', async () => {
    const rows = (await sql.unsafe(toPgPlaceholders(FEED_OVERDUE_SQL), [1] as never[])) as unknown as FeedHeadRow[];
    // HC-SO-000010 (CONFIRMED, 2026-01-05) yes; HC-SO-000011/12 are DELIVERED;
    // HC-SO-013495 has no date; 2990-SO-000013 is the other company.
    expect(rows.map((r) => r.doc_no)).toEqual(['HC-SO-000010']);
    expect(rows[0]!.venue).toBe('PG Showroom');
    expect(toSheetRecord(rows[0]!, [])).toMatchObject({ DocNo: 'SO-000010', SalesExemptionExpiryDate: '2026-01-05', SOUDF_VENUE: 'PG Showroom', SalesLocation: 'PG' });
    // A date pushed into the future takes the order off the list.
    await sql`UPDATE scm.mfg_sales_orders SET customer_delivery_date = '2099-01-01' WHERE doc_no = 'HC-SO-000010'`;
    expect(await sql.unsafe(toPgPlaceholders(FEED_OVERDUE_SQL), [1] as never[])).toHaveLength(0);
    await sql`UPDATE scm.mfg_sales_orders SET customer_delivery_date = '2026-01-05' WHERE doc_no = 'HC-SO-000010'`;
  });

  test('balance-collection: delivered orders still owing, this company only', async () => {
    const rows = (await sql.unsafe(toPgPlaceholders(FEED_BALANCE_COLLECTION_SQL), [1] as never[])) as unknown as FeedHeadRow[];
    // HC-SO-000011 owes 600.00 (dated 2026-02-01); HC-SO-2609-078 is DELIVERED with
    // nothing paid and no date, so it comes last; HC-SO-000012 is paid in full;
    // the CONFIRMED ones are not delivered.
    expect(rows.map((r) => [r.doc_no, r.balance_sen_live])).toEqual([['HC-SO-000011', 60000], ['HC-SO-2609-078', 300000]]);
    expect(toSheetRecord(rows[0]!, [])).toMatchObject({ DocNo: 'SO-000011', Total: 1000, SOUDF_BALANCE: 600, Status: 'DELIVERED' });
  });

  test('limit pages, and the lines query answers the page\'s doc numbers', async () => {
    const first = await page(1, FEED_EPOCH, 1);
    expect(first).toHaveLength(1);
    const lines = (await sql.unsafe(toPgPlaceholders(feedLinesSql(2)), ['HC-SO-013495', 'HC-SO-2609-078'] as never[])) as unknown as FeedLineRow[];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ doc_no: 'HC-SO-013495', item_group: 'MATTRESS', stock_status: 'READY' });
  });

  test('the mapped record is what the sheet writes: AutoCount key, short location, ringgit, region', async () => {
    const all = await page(1, FEED_EPOCH, 10);
    const sg = byDoc(all, 'HC-SO-2609-078');
    const so = byDoc(all, 'HC-SO-013495');
    const rec = toSheetRecord(so!, [{ doc_no: so!.doc_no, item_group: 'MATTRESS', item_code: 'M1', stock_status: 'READY', cancelled: false }]);
    expect(rec).toMatchObject({
      DocNo: 'SO-013495',
      ErpDocNo: 'HC-SO-013495',
      TransferTo: 'HC-DO-2609-001',
      SalesLocation: 'KL',
      Total: 5000,
      SOUDF_BALANCE: 3000,
      Remark2: 'READY',
      SOUDF_ToPONo: 'PO-2609-001',
      InvAddr3: '43300 Seri Kembangan',
      InvAddr4: 'Selangor',
      Region: 'WEST',
    });
    expect(rec.SalesAgent).toBeTruthy();
    const recSg = toSheetRecord(sg!, []);
    expect(recSg).toMatchObject({ DocNo: 'HC-SO-2609-078', Region: 'SG', Remark2: 'READY (PARTIAL)', SalesLocation: 'SRW' });
  });

  test('the write leg: found by the AutoCount number, keeps what the sheet did not send, moves the order forward', async () => {
    const before = byDoc(await page(1, FEED_EPOCH, 10), 'HC-SO-013495').last_modified_text;
    const upd1 = toPgPlaceholders(updateFromSheetSql(1));
    const hit = await sql.unsafe(upd1, ['SO-013495', 'Done Scheduling', '2026-10-01', 1] as never[]);
    expect(hit.map((r) => [r.doc_no, r.sheet_doc_no])).toEqual([['HC-SO-013495', 'SO-013495']]);
    const [row1] = await sql`SELECT remark4, customer_delivery_date::text AS d FROM scm.mfg_sales_orders WHERE doc_no = 'HC-SO-013495'`;
    expect(row1).toEqual({ remark4: 'Done Scheduling', d: '2026-10-01' });

    // Only the date this time (Remark4 absent) — by the ERP number.
    await sql.unsafe(upd1, ['HC-SO-013495', null, '2026-10-02', 1] as never[]);
    const [row2] = await sql`SELECT remark4, customer_delivery_date::text AS d FROM scm.mfg_sales_orders WHERE doc_no = 'HC-SO-013495'`;
    expect(row2).toEqual({ remark4: 'Done Scheduling', d: '2026-10-02' });

    // Only the remark, blank on purpose (col A cleared) — the date stays.
    await sql.unsafe(upd1, ['SO-013495', '', null, 1] as never[]);
    const [row3] = await sql`SELECT remark4, customer_delivery_date::text AS d FROM scm.mfg_sales_orders WHERE doc_no = 'HC-SO-013495'`;
    expect(row3).toEqual({ remark4: '', d: '2026-10-02' });

    // The order now sits past the old checkpoint, so the next pull carries it.
    const after = await page(1, before, 10);
    expect(after.map((r) => r.doc_no)).toEqual(['HC-SO-013495']);

    // A batch: two live orders and two misses in ONE statement — only the
    // hits come back, each with the sheet's own key. Nulls in every column of
    // a VALUES row still type-check (the casts carry the types).
    const upd4 = toPgPlaceholders(updateFromSheetSql(4));
    const batch = await sql.unsafe(upd4, [
      'SO-013495', 'Done Delivered', null,
      'HC-SO-2609-078', null, '2026-10-05',
      '2990-SO-2609-001', 'x', null,
      'SO-999999', null, null,
      1,
    ] as never[]);
    expect(batch.map((r) => [r.doc_no, r.sheet_doc_no]).sort()).toEqual([
      ['HC-SO-013495', 'SO-013495'],
      ['HC-SO-2609-078', 'HC-SO-2609-078'],
    ]);
    const [b1] = await sql`SELECT remark4, customer_delivery_date::text AS d FROM scm.mfg_sales_orders WHERE doc_no = 'HC-SO-013495'`;
    expect(b1).toEqual({ remark4: 'Done Delivered', d: '2026-10-02' });
    const [b2] = await sql`SELECT customer_delivery_date::text AS d FROM scm.mfg_sales_orders WHERE doc_no = 'HC-SO-2609-078'`;
    expect(b2).toEqual({ d: '2026-10-05' });

    // Other company, DRAFT, CANCELLED, unknown: nothing written.
    for (const key of ['2990-SO-2609-001', 'SO-000001', 'SO-000002', 'SO-999999']) {
      expect(await sql.unsafe(upd1, [key, 'x', null, 1] as never[])).toHaveLength(0);
    }
  });
});
