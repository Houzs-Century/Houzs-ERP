import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { deliveryFeeStateKey } from '../src/scm/shared/service-lines';

/*
 * The delivery-fee rebuild must REUSE its lines (migration 0310).
 *
 * Before 0310 the RPC deleted every SVC-DELIVERY* line and inserted a fresh
 * set, so each rebuild handed the line a new id — and
 * delivery_order_items.so_item_id is ON DELETE SET NULL (0235), so a Delivery
 * Order that had shipped a delivery fee silently lost the link naming the SO
 * line it fulfilled. These tests assert the row identity survives, which is
 * what makes an editable delivery charge safe to expose.
 *
 * The fixture is hand-built rather than drizzle-pushed for the same reason the
 * sibling pg tests are: it must contain exactly the columns the function
 * names, so a column the function forgets to carry fails here rather than in
 * production.
 */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

let admin: Sql;

const migration = (name: string) => readFile(
  fileURLToPath(new URL(`../src/db/migrations-pg/${name}`, import.meta.url)),
  'utf8',
);

const DOC = '2990-SO-2608-001';

async function resetFixture(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') {
    throw new Error('PG integration tests require the disposable houzs_test database');
  }

  await sql.unsafe(`
    DROP SCHEMA IF EXISTS scm CASCADE;
    CREATE SCHEMA scm;

    CREATE TABLE scm.mfg_sales_orders (
      doc_no text PRIMARY KEY,
      company_id bigint,
      cross_category_source_doc_no text,
      delivery_fee_sen bigint NOT NULL DEFAULT 0,
      updated_at timestamptz
    );

    -- Every column the RPC reads or writes, and nothing else.
    CREATE TABLE scm.mfg_sales_order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id bigint,
      doc_no text NOT NULL,
      line_no integer,
      line_date date,
      debtor_name text,
      item_group text,
      item_code text,
      description text,
      description2 text,
      remark text,
      uom text,
      qty integer NOT NULL DEFAULT 1,
      unit_price_sen bigint NOT NULL DEFAULT 0,
      discount_sen bigint NOT NULL DEFAULT 0,
      total_sen bigint NOT NULL DEFAULT 0,
      total_inc_sen bigint NOT NULL DEFAULT 0,
      balance_sen bigint NOT NULL DEFAULT 0,
      variants jsonb,
      unit_cost_sen bigint NOT NULL DEFAULT 0,
      line_cost_sen bigint NOT NULL DEFAULT 0,
      line_margin_sen bigint NOT NULL DEFAULT 0,
      divan_price_sen bigint NOT NULL DEFAULT 0,
      leg_price_sen bigint NOT NULL DEFAULT 0,
      special_order_price_sen bigint NOT NULL DEFAULT 0,
      custom_specials jsonb,
      line_delivery_date date,
      line_delivery_date_overridden boolean NOT NULL DEFAULT false,
      warehouse_id uuid,
      branding text,
      venue text,
      stock_status text,
      cancelled boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    -- The relationship the whole migration exists to protect.
    CREATE TABLE scm.delivery_order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      do_doc_no text NOT NULL,
      so_item_id uuid REFERENCES scm.mfg_sales_order_items(id) ON DELETE SET NULL
    );
  `);
  await sql.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN BYPASSRLS;
      END IF;
    END $$;
  `);
  await sql.unsafe(await migration('0310_scm_rebuild_so_delivery_lines_keeps_identity.sql'));
  await sql.unsafe(await migration('0314_scm_so_delivery_rebuild_refuses_a_stale_derivation.sql'));
}

/** One rebuilt line as the route builds it: gross unit, operator discount, net total. */
const feeRow = (itemCode: string, unitSen: number, discountSen = 0, lineNo = 0) => {
  const net = unitSen - discountSen;
  return {
    doc_no: DOC,
    line_no: lineNo,
    line_date: '2026-08-20',
    debtor_name: 'Tan Yee Heng',
    item_group: 'service',
    item_code: itemCode,
    description: 'Delivery fee',
    description2: null,
    remark: null,
    uom: 'UNIT',
    qty: 1,
    unit_price_sen: unitSen,
    discount_sen: discountSen,
    total_sen: net,
    total_inc_sen: net,
    balance_sen: net,
    variants: null,
    unit_cost_sen: 0,
    line_cost_sen: 0,
    line_margin_sen: net,
    divan_price_sen: 0,
    leg_price_sen: 0,
    special_order_price_sen: 0,
    custom_specials: null,
    line_delivery_date: null,
    line_delivery_date_overridden: false,
    warehouse_id: null,
    branding: null,
    venue: null,
    stock_status: 'READY',
  };
};

/* p_rows is bound through `admin.json(...)`, never `JSON.stringify`. postgres.js
   serializes a JS value for the jsonb OID exactly once; stringifying first
   serializes it a second time, so the array reaches Postgres as a JSON STRING
   and jsonb_array_elements answers "cannot extract elements from a scalar".
   The same trap is called out in soConcurrency.pg.test.ts and
   variantMergePreservesKeys.pg.test.ts. */
const rebuild = (
  sql: Sql,
  rows: unknown[],
  feeSen: number,
  source: string | null = null,
  /* The operator-owned fee state the caller derived FROM (0314). undefined =
     the pre-0314 four-argument call, which is still what the repair script and
     the unraced cases below use. */
  expectState?: unknown,
) => sql.unsafe<Array<{ rebuilt: boolean }>>(
  'SELECT scm.rebuild_mfg_so_delivery_lines($1, $2, $3, $4::jsonb, $5::jsonb) AS rebuilt',
  [DOC, source, feeSen, admin.json(rows), expectState === undefined ? null : admin.json(expectState as never)],
);

/** Read the fee lines the way the route reads them, then build the expectation
 *  with the SAME helper the route uses. That pairing is the point: it is what
 *  proves the TypeScript object and the SQL jsonb_object_agg agree, which is the
 *  only way this guard can be silently wrong (an integer rendered 1.00 would
 *  refuse every rebuild forever, and no fee would ever change again). */
const stateNow = async (sql: Sql) => deliveryFeeStateKey(
  (await sql.unsafe(`
    SELECT id, item_code, qty, unit_price_sen, discount_sen
      FROM scm.mfg_sales_order_items
     WHERE doc_no = '${DOC}'
       AND item_code IN ('SVC-DELIVERY', 'SVC-DELIVERY-CROSS', 'SVC-DELIVERY-ADD')
       AND COALESCE(cancelled, false) = false
  `)) as unknown as Array<{ id: string; item_code: string; qty: number; unit_price_sen: number; discount_sen: number }>,
);

const feeLines = (sql: Sql) => sql.unsafe(`
  SELECT id, item_code, line_no, unit_price_sen, discount_sen, total_sen, cancelled
    FROM scm.mfg_sales_order_items
   WHERE doc_no = '${DOC}'
   ORDER BY item_code, line_no, id
`);

describePg('the delivery-fee rebuild keeps its lines (0310)', () => {
  beforeAll(async () => {
    admin = postgres(url, { max: 4, onnotice: () => {} });
  });

  afterAll(async () => {
    await admin?.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await resetFixture(admin);
    await admin.unsafe(`
      INSERT INTO scm.mfg_sales_orders (doc_no, company_id, delivery_fee_sen)
      VALUES ('${DOC}', 2, 25000);
    `);
    await rebuild(admin, [feeRow('SVC-DELIVERY', 25000)], 25000);
  });

  test('a repriced fee keeps the same row, so the Delivery Order keeps its link', async () => {
    const [before] = await feeLines(admin);
    await admin.unsafe(
      `INSERT INTO scm.delivery_order_items (do_doc_no, so_item_id) VALUES ('2990-DO-2608-001', $1)`,
      [before.id],
    );

    await rebuild(admin, [feeRow('SVC-DELIVERY', 30000)], 30000);

    const [after] = await feeLines(admin);
    expect(after.id).toBe(before.id);
    expect(Number(after.unit_price_sen)).toBe(30000);

    const [doLine] = await admin.unsafe(`SELECT so_item_id FROM scm.delivery_order_items`);
    expect(doLine.so_item_id).toBe(before.id);
  });

  test('an operator discount rebuilds as a reduced total on the SAME row (250 -> 125)', async () => {
    const [before] = await feeLines(admin);

    await rebuild(admin, [feeRow('SVC-DELIVERY', 25000, 12500)], 12500);

    const [after] = await feeLines(admin);
    expect(after.id).toBe(before.id);
    expect(Number(after.unit_price_sen)).toBe(25000);
    expect(Number(after.discount_sen)).toBe(12500);
    expect(Number(after.total_sen)).toBe(12500);

    const [header] = await admin.unsafe(
      `SELECT delivery_fee_sen FROM scm.mfg_sales_orders WHERE doc_no = '${DOC}'`,
    );
    expect(Number(header.delivery_fee_sen)).toBe(12500);
  });

  test('a component that no longer exists is removed, and its link goes with it', async () => {
    await rebuild(admin, [feeRow('SVC-DELIVERY', 25000), feeRow('SVC-DELIVERY-ADD', 5000, 0, 1)], 30000);
    const rows = await feeLines(admin);
    const addLine = rows.find((r) => r.item_code === 'SVC-DELIVERY-ADD');
    await admin.unsafe(
      `INSERT INTO scm.delivery_order_items (do_doc_no, so_item_id) VALUES ('2990-DO-2608-002', $1)`,
      [addLine!.id],
    );

    // The operator clears the free-form addition: that component is gone.
    await rebuild(admin, [feeRow('SVC-DELIVERY', 25000)], 25000);

    const after = await feeLines(admin);
    expect(after).toHaveLength(1);
    expect(after[0].item_code).toBe('SVC-DELIVERY');
    const [doLine] = await admin.unsafe(`SELECT so_item_id FROM scm.delivery_order_items`);
    expect(doLine.so_item_id).toBeNull();
  });

  test('two lines sharing one item_code are matched by position, not collapsed', async () => {
    // A follow-up order that also crosses categories emits SVC-DELIVERY-CROSS
    // twice — the follow-up base and the cross-category surcharge.
    await rebuild(admin, [
      feeRow('SVC-DELIVERY-CROSS', 15000, 0, 0),
      feeRow('SVC-DELIVERY-CROSS', 8000, 0, 1),
    ], 23000);
    const before = (await feeLines(admin)).filter((r) => r.item_code === 'SVC-DELIVERY-CROSS');
    expect(before).toHaveLength(2);

    await rebuild(admin, [
      feeRow('SVC-DELIVERY-CROSS', 15000, 0, 0),
      feeRow('SVC-DELIVERY-CROSS', 9000, 0, 1),
    ], 24000);

    const after = (await feeLines(admin)).filter((r) => r.item_code === 'SVC-DELIVERY-CROSS');
    expect(after).toHaveLength(2);
    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
    expect(after.map((r) => Number(r.unit_price_sen)).sort((a, b) => a - b)).toEqual([9000, 15000]);
  });

  test('a cancelled fee line is replaced, never revived', async () => {
    await admin.unsafe(`UPDATE scm.mfg_sales_order_items SET cancelled = true WHERE doc_no = '${DOC}'`);
    const [cancelled] = await feeLines(admin);

    await rebuild(admin, [feeRow('SVC-DELIVERY', 25000)], 25000);

    const after = await feeLines(admin);
    expect(after).toHaveLength(1);
    expect(after[0].id).not.toBe(cancelled.id);
    expect(after[0].cancelled).toBe(false);
  });

  test('an empty row set clears every delivery line', async () => {
    await rebuild(admin, [], 0);
    expect(await feeLines(admin)).toHaveLength(0);
  });

  test('two concurrent rebuilds serialize and leave exactly one line', async () => {
    // 0214 records two live double-billings (SO-2606-043, SO-2607-010) from
    // rebuilds interleaving under READ COMMITTED. Reusing rows must not weaken
    // the advisory xact lock that fixed it.
    const a = postgres(url, { max: 1, onnotice: () => {} });
    const b = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await Promise.all([
        a.begin((tx) => rebuild(tx as unknown as Sql, [feeRow('SVC-DELIVERY', 25000)], 25000)),
        b.begin((tx) => rebuild(tx as unknown as Sql, [feeRow('SVC-DELIVERY', 25000)], 25000)),
      ]);
    } finally {
      await a.end({ timeout: 5 });
      await b.end({ timeout: 5 });
    }

    const rows = await feeLines(admin);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].total_sen)).toBe(25000);
  });
});

/*
 * A derivation computed from fee lines that have since MOVED is refused (0314).
 *
 * The 0214 advisory lock is taken INSIDE this function; the derivation reads the
 * fee lines BEFORE calling it. Read, then lock. One ordinary SO Detail Save fans
 * its dirty-line PATCHes out in parallel and each ends in rederiveDeliveryFee,
 * so a salesperson who cuts the fee 250 -> 125 AND changes a sofa quantity in
 * the same Save had two rebuilds in flight — and the one derived from the
 * pre-discount snapshot wrote last. Quoted RM 125, invoiced RM 250.
 *
 * These cases run the interleave for real: the state is read, a concurrent
 * commit moves it, and the stale derivation is then offered to the function.
 */
describePg('the delivery-fee rebuild refuses a stale derivation (0314)', () => {
  beforeAll(async () => { admin = postgres(url, { max: 4, onnotice: () => {} }); });
  afterAll(async () => { await admin?.end({ timeout: 5 }); });

  beforeEach(async () => {
    await resetFixture(admin);
    await admin.unsafe(`
      INSERT INTO scm.mfg_sales_orders (doc_no, company_id, delivery_fee_sen)
      VALUES ('${DOC}', 2, 25000);
    `);
    await rebuild(admin, [feeRow('SVC-DELIVERY', 25000)], 25000);
  });

  test('the expectation TypeScript builds is the expectation SQL re-reads', async () => {
    const [rebuilt] = await rebuild(admin, [feeRow('SVC-DELIVERY', 25000)], 25000, null, await stateNow(admin));
    expect(rebuilt.rebuilt).toBe(true);
  });

  test('REGRESSION: a stale derivation does NOT put the operator discount back to 250', async () => {
    const stale = await stateNow(admin);                 // what P_sofa derived from

    // P_fee lands: the operator's 250 -> 125 commits while P_sofa is deriving.
    await admin.unsafe(`
      UPDATE scm.mfg_sales_order_items
         SET discount_sen = 12500, total_sen = 12500, total_inc_sen = 12500, balance_sen = 12500
       WHERE doc_no = '${DOC}' AND item_code = 'SVC-DELIVERY'
    `);
    await admin.unsafe(`UPDATE scm.mfg_sales_orders SET delivery_fee_sen = 12500 WHERE doc_no = '${DOC}'`);

    // P_sofa now offers its pre-discount derivation. Under 0310 this WROTE.
    const [refused] = await rebuild(admin, [feeRow('SVC-DELIVERY', 25000)], 25000, null, stale);
    expect(refused.rebuilt).toBe(false);

    const [line] = await feeLines(admin);
    expect(Number(line.discount_sen)).toBe(12500);       // the reduction survived
    expect(Number(line.total_sen)).toBe(12500);
    const [header] = await admin.unsafe(`SELECT delivery_fee_sen FROM scm.mfg_sales_orders WHERE doc_no = '${DOC}'`);
    expect(Number(header.delivery_fee_sen)).toBe(12500); // and so did the mirror
  });

  test('the SAME derivation, re-run against the moved state, lands', async () => {
    const stale = await stateNow(admin);
    await admin.unsafe(`
      UPDATE scm.mfg_sales_order_items SET discount_sen = 12500, total_sen = 12500
       WHERE doc_no = '${DOC}' AND item_code = 'SVC-DELIVERY'
    `);
    expect((await rebuild(admin, [feeRow('SVC-DELIVERY', 25000)], 25000, null, stale))[0].rebuilt).toBe(false);

    // What the route does next: read again, derive again, call again.
    const fresh = await stateNow(admin);
    const [ok] = await rebuild(admin, [feeRow('SVC-DELIVERY', 25000, 12500)], 12500, null, fresh);
    expect(ok.rebuilt).toBe(true);
    const [line] = await feeLines(admin);
    expect(Number(line.unit_price_sen)).toBe(25000);
    expect(Number(line.discount_sen)).toBe(12500);
    expect(Number(line.total_sen)).toBe(12500);
  });

  test('a DELETED fee line moves the state too — the derivation is refused', async () => {
    const stale = await stateNow(admin);
    await admin.unsafe(`DELETE FROM scm.mfg_sales_order_items WHERE doc_no = '${DOC}'`);
    expect((await rebuild(admin, [feeRow('SVC-DELIVERY', 25000)], 25000, null, stale))[0].rebuilt).toBe(false);
    expect(await feeLines(admin)).toHaveLength(0);
  });

  test('NULL means no expectation — the repair script and the create path still write', async () => {
    const [rebuilt] = await rebuild(admin, [feeRow('SVC-DELIVERY', 30000)], 30000);
    expect(rebuilt.rebuilt).toBe(true);
    expect(Number((await feeLines(admin))[0].unit_price_sen)).toBe(30000);
  });

  test('an SO with no fee lines at all expects an empty object, not null', async () => {
    await admin.unsafe(`DELETE FROM scm.mfg_sales_order_items WHERE doc_no = '${DOC}'`);
    expect(await stateNow(admin)).toEqual({});
    const [rebuilt] = await rebuild(admin, [feeRow('SVC-DELIVERY', 25000)], 25000, null, {});
    expect(rebuilt.rebuilt).toBe(true);
    expect(await feeLines(admin)).toHaveLength(1);
  });
});
