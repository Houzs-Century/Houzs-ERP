/* EXECUTES the SQL behind the Sales Order and Purchase Invoice list numbers
 * (perf/so-and-pi-lists) against real Postgres, on a fixture whose expected
 * numbers are computed independently in JS from the same rows.
 *
 * What it pins: the status pills, the On Hold pill, the money strip (Revenue /
 * Outstanding / Paid), the customers read and the funnel-values reads give the
 * SAME numbers and rows the PostgREST path gives — for the unfiltered tab, a
 * status tab, the Cancelled tab (whose money keeps cancelled orders), free-text
 * search including a typed local phone number, a date window, the Customer /
 * Currency funnels (MYR admits a blank currency), a column funnel with its blank
 * cell, a second-level filter, a rep's sales scope with open-to-all orders, and
 * company isolation. The closures are the REAL ones (prepareSoListRead,
 * scopeToCompany, applySoScope); only their SQL translation is new.
 *
 * SKIPPED, not failed, without TEST_DATABASE_URL, matching the other pg suites.
 */
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fakeSb } from '../src/scm/lib/fake-postgrest';
import { prepareSoListRead, type SoListParams } from '../src/scm/lib/so-list-read';
import { soListKpiStatements, soListKpisFromRows } from '../src/scm/lib/so-list-kpis-sql';
import { moneySkipsCancelled } from '../src/scm/lib/list-money-cancelled';
import { tallyStatusRows } from '../src/scm/lib/status-counts';
import { SO_TAB_STATUSES } from '../src/scm/lib/so-tab-statuses';
import { scopeToCompany } from '../src/scm/lib/companyScope';
import { applySoScope } from '../src/scm/lib/salesScope';
import { soCustomerRowsStatement } from '../src/scm/lib/so-customers-sql';
import { soFunnelStatements } from '../src/scm/lib/so-funnel-values-sql';
import { pillsFromGroups, statusCountsStatement } from '../src/scm/lib/list-status-counts-sql';
import { PI_STATUS_BUCKETS } from '../src/scm/lib/pi-status-buckets';
import { jsonRows } from '../src/scm/lib/list-sql';
import { SqlParams, selectCol, whereOf } from '../src/scm/lib/pgrest-sql';

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

let sql: Sql;

const REP = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const WH = '33333333-3333-4333-8333-333333333333';

type So = {
  doc_no: string; company_id: number; status: string | null; on_hold: boolean; so_date: string; debtor_name: string;
  debtor_code: string | null; phone: string | null; currency: string | null; city: string | null; branding: string | null;
  local_total_sen: number; balance_sen: number; access_staff_ids: string[]; open_to_all: boolean;
  linked_ac_docno: string | null; created_at: string; paid: number;
};

const so = (over: Partial<So> & { doc_no: string }): So => ({
  company_id: 1, status: 'CONFIRMED', on_hold: false, so_date: '2026-08-10', debtor_name: 'ALI', debtor_code: null,
  phone: null, currency: 'MYR', city: 'KL', branding: null, local_total_sen: 10_000, balance_sen: 10_000,
  access_staff_ids: [OTHER], open_to_all: false, linked_ac_docno: null, created_at: '2026-08-10T02:00:00+00:00', paid: 0,
  ...over,
});

const ORDERS: So[] = [
  so({ doc_no: 'SO-A', debtor_name: 'TAN AH KOW', phone: '+60123456789', paid: 4_000, access_staff_ids: [REP] }),
  so({ doc_no: 'SO-B', status: 'DELIVERED', local_total_sen: 25_000, balance_sen: 25_000, paid: 25_000, city: null, currency: null }),
  so({ doc_no: 'SO-C', status: 'SHIPPED', local_total_sen: 7_000, balance_sen: 7_000, so_date: '2026-09-02', open_to_all: true }),
  so({ doc_no: 'SO-D', status: 'CANCELLED', local_total_sen: 9_000, balance_sen: 9_000, paid: 1_000, debtor_name: 'Tanjung Sdn' }),
  so({ doc_no: 'SO-E', status: 'CONFIRMED', on_hold: true, local_total_sen: 3_000, balance_sen: 3_000, currency: 'USD', linked_ac_docno: 'AC-9' }),
  so({ doc_no: 'SO-F', status: 'ON_HOLD', local_total_sen: 1_500, balance_sen: 1_500, city: '' }),
  so({ doc_no: 'SO-G', status: null, local_total_sen: 800, balance_sen: 800, debtor_name: 'NULL STATUS' }),
  so({ doc_no: 'SO-H', status: 'legacy', local_total_sen: 600, balance_sen: 600, so_date: '2026-07-30' }),
  so({ doc_no: 'SO-I', status: 'DRAFT', local_total_sen: 0, balance_sen: 0, branding: 'ZANOTTI', access_staff_ids: [REP] }),
  so({ doc_no: 'SO-X', company_id: 2, debtor_name: 'TAN OTHER CO', local_total_sen: 99_999, balance_sen: 99_999, paid: 5 }),
];

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
    DROP TABLE IF EXISTS scm.mfg_sales_order_payments CASCADE;
    DROP TABLE IF EXISTS scm.mfg_sales_orders CASCADE;
    DROP TABLE IF EXISTS scm.purchase_invoices CASCADE;
    CREATE TABLE scm.mfg_sales_orders (
      doc_no text PRIMARY KEY, company_id bigint NOT NULL, status text, on_hold boolean NOT NULL DEFAULT false,
      so_date date, debtor_name text, debtor_code text, agent text, sales_location text, ref text, customer_so_no text,
      branding text, phone text, email text, currency text, city text, address1 text, address2 text, postcode text,
      customer_state text, venue text, note text, customer_type text, building_type text, customer_country text,
      processing_date date, customer_delivery_date date, amended_delivery_date date,
      local_total_sen integer NOT NULL DEFAULT 0, balance_sen integer NOT NULL DEFAULT 0, paid_sen integer NOT NULL DEFAULT 0,
      access_staff_ids uuid[] NOT NULL DEFAULT '{}', open_to_all boolean NOT NULL DEFAULT false, salesperson_id uuid,
      linked_ac_docno text, created_at timestamptz, line_count integer, wh_ids uuid[] NOT NULL DEFAULT '{}'
    );
    CREATE TABLE scm.mfg_sales_order_payments (so_doc_no text NOT NULL, amount_sen integer NOT NULL, approval_code text, company_id bigint);
    CREATE VIEW scm.mfg_sales_orders_with_payment_totals AS
      SELECT so.*, COALESCE(p.paid, 0)::bigint AS paid_total_sen, (so.local_total_sen - COALESCE(p.paid, 0))::bigint AS balance_sen_live
      FROM scm.mfg_sales_orders so
      LEFT JOIN (SELECT so_doc_no, sum(amount_sen) AS paid FROM scm.mfg_sales_order_payments GROUP BY so_doc_no) p ON p.so_doc_no = so.doc_no;
    CREATE FUNCTION scm.so_line_warehouse_ids(so scm.mfg_sales_orders_with_payment_totals) RETURNS uuid[]
      LANGUAGE sql STABLE AS $$ SELECT so.wh_ids $$;
    CREATE TABLE scm.purchase_invoices (id text PRIMARY KEY, company_id bigint NOT NULL, status text, on_hold boolean NOT NULL DEFAULT false);
  `);
  for (const o of ORDERS) {
    await s`INSERT INTO scm.mfg_sales_orders
      (doc_no, company_id, status, on_hold, so_date, debtor_name, debtor_code, phone, currency, city, branding,
       local_total_sen, balance_sen, access_staff_ids, open_to_all, linked_ac_docno, created_at, line_count)
      VALUES (${o.doc_no}, ${o.company_id}, ${o.status}, ${o.on_hold}, ${o.so_date}, ${o.debtor_name}, ${o.debtor_code},
       ${o.phone}, ${o.currency}, ${o.city}, ${o.branding}, ${o.local_total_sen}, ${o.balance_sen},
       ${'{' + o.access_staff_ids.join(',') + '}'}::uuid[], ${o.open_to_all}, ${o.linked_ac_docno}, ${o.created_at}, 1)`;
    if (o.paid) await s`INSERT INTO scm.mfg_sales_order_payments (so_doc_no, amount_sen, company_id) VALUES (${o.doc_no}, ${o.paid}, ${o.company_id})`;
  }
  await s`UPDATE scm.mfg_sales_orders SET wh_ids = ${'{' + WH + '}'}::uuid[] WHERE doc_no IN ('SO-B', 'SO-C')`;
  const pis: Array<[string, number, string | null, boolean]> = [
    ['p1', 1, 'DRAFT', false], ['p2', 1, 'POSTED', false], ['p3', 1, 'POSTED', true], ['p4', 1, 'PAID', false],
    ['p5', 1, 'PARTIALLY_PAID', false], ['p6', 1, 'CANCELLED', false], ['p7', 1, 'ON_HOLD', false], ['p8', 1, null, false],
    ['p9', 2, 'POSTED', false],
  ];
  for (const [id, co, st, held] of pis) await s`INSERT INTO scm.purchase_invoices VALUES (${id}, ${co}, ${st}, ${held})`;
}

const params = (over: Partial<SoListParams>): SoListParams => ({
  status: null, q: null, sort: null, from: null, to: null, f: [], debtorNames: null, currencies: null, brandings: null, cols: null, ...over,
});
const ctx = (companyId: number) => ({ get: (k: string) => (k === 'companyId' ? companyId : undefined) });

/* ── The independent oracle: the PostgREST path's arithmetic over the rows its
   predicates admit, written out in plain JS. ─────────────────────────────── */
const SO_STATUSES = new Set(['DRAFT', 'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'INVOICED', 'CLOSED', 'ON_HOLD', 'CANCELLED']);
function oracle(rows: So[], tabStatus: string | null) {
  const counted = tallyStatusRows({ data: rows, error: null }, () => 1);
  const held = rows.filter((r) => r.on_hold || r.status === 'ON_HOLD').length;
  const money = rows.filter((r) => !moneySkipsCancelled(tabStatus) || r.status === null || r.status !== 'CANCELLED');
  return { counted, held, money };
}
const inScopeRep = (r: So) => r.access_staff_ids.includes(REP) || r.open_to_all;
const tabMatch = (tab: string | null) => (r: So) => {
  if (!tab) return true;
  if (tab === 'ON_HOLD') return r.on_hold || r.status === 'ON_HOLD';
  if (tab === 'OTHER') return r.status === null || !SO_STATUSES.has(r.status);
  return (SO_TAB_STATUSES[tab] ?? [tab]).includes(r.status as string);
};

async function runKpis(p: SoListParams, companyId: number, scopeIds: string[] | null) {
  const sb = fakeSb({ mfg_sales_order_payments: [], staff: [], warehouses: [], mfg_sales_orders: [], mfg_sales_orders_with_payment_totals: [] });
  const read = await prepareSoListRead(sb, ctx(companyId), p, scopeIds, null, new Date('2026-11-10T00:00:00Z'));
  if (!read.ok) throw new Error(JSON.stringify(read.body));
  const st = soListKpiStatements(read, moneySkipsCancelled(p.status));
  const [countRows, moneyRows] = await Promise.all([sql.unsafe(st.counts.text, st.counts.values), sql.unsafe(st.money.text, st.money.values)]);
  return { kpis: soListKpisFromRows(countRows as never, (moneyRows as never[])[0]), headerRowsSql: st };
}

function expectKpis(got: Awaited<ReturnType<typeof runKpis>>['kpis'], scoped: So[], header: So[], tab: string | null) {
  const want = oracle(scoped, tab);
  expect(got.counted).toEqual(want.counted);
  expect(got.held).toEqual({ ok: true, n: want.held });
  const m = oracle(header, tab).money;
  expect(got.money).toEqual({
    revenueSen: m.reduce((s, r) => s + r.local_total_sen, 0),
    outstandingSen: m.reduce((s, r) => s + (r.local_total_sen - r.paid), 0),
    paidSen: m.reduce((s, r) => s + r.paid, 0),
  });
}

describePg('SO / PI list numbers over SQL equal the PostgREST path', () => {
  beforeAll(async () => {
    sql = postgres(url, { max: 1, prepare: false, fetch_types: false, types: { bigint: { to: 20, from: [20], parse: (x: string) => Number(x), serialize: (x: number) => String(x) } } });
    await resetFixture(sql);
  });
  afterAll(async () => { await sql?.end(); });

  const co1 = ORDERS.filter((r) => r.company_id === 1);

  test('unfiltered All tab, view-all: every pill, held overlay, money without cancelled', async () => {
    const { kpis } = await runKpis(params({}), 1, null);
    expectKpis(kpis, co1, co1, null);
    expect(kpis.counted).toEqual({ ok: true, byStatus: { CONFIRMED: 2, DELIVERED: 1, SHIPPED: 1, CANCELLED: 1, ON_HOLD: 1, UNKNOWN: 1, LEGACY: 1, DRAFT: 1 } });
    expect(kpis.held.n).toBe(2);
    expect(kpis.money.revenueSen).toBe(10_000 + 25_000 + 7_000 + 3_000 + 1_500 + 800 + 600 + 0);
  });

  test('a status tab narrows the money, never the pills; the Cancelled tab keeps cancelled money', async () => {
    const delivered = await runKpis(params({ status: 'DELIVERED' }), 1, null);
    expectKpis(delivered.kpis, co1, co1.filter(tabMatch('DELIVERED')), 'DELIVERED');
    const cancelled = await runKpis(params({ status: 'CANCELLED' }), 1, null);
    expectKpis(cancelled.kpis, co1, co1.filter(tabMatch('CANCELLED')), 'CANCELLED');
    expect(cancelled.kpis.money).toEqual({ revenueSen: 9_000, outstandingSen: 8_000, paidSen: 1_000 });
    const held = await runKpis(params({ status: 'ON_HOLD' }), 1, null);
    expectKpis(held.kpis, co1, co1.filter(tabMatch('ON_HOLD')), 'ON_HOLD');
    const other = await runKpis(params({ status: 'OTHER' }), 1, null);
    expectKpis(other.kpis, co1, co1.filter(tabMatch('OTHER')), 'OTHER');
  });

  test('free-text search, case-insensitive, including a typed local phone number', async () => {
    const tan = await runKpis(params({ q: 'tan' }), 1, null);
    expectKpis(tan.kpis, co1, co1.filter((r) => /tan/i.test(r.debtor_name) || /tan/i.test(r.doc_no)), null);
    const phone = await runKpis(params({ q: '012-345 6789' }), 1, null);
    expectKpis(phone.kpis, co1, co1.filter((r) => r.doc_no === 'SO-A'), null);
  });

  test('date window, Customer / Currency funnels (MYR admits blank), column funnel with its blank cell', async () => {
    const win = await runKpis(params({ from: '2026-08-01', to: '2026-08-31' }), 1, null);
    expectKpis(win.kpis, co1, co1.filter((r) => r.so_date >= '2026-08-01' && r.so_date <= '2026-08-31'), null);
    const myr = await runKpis(params({ currencies: ['MYR'], debtorNames: ['ALI', 'TAN AH KOW'] }), 1, null);
    expectKpis(myr.kpis, co1, co1.filter((r) => (r.currency === 'MYR' || r.currency === null) && ['ALI', 'TAN AH KOW'].includes(r.debtor_name)), null);
    const city = await runKpis(params({ cols: { city: ['KL', '—'] } }), 1, null);
    expectKpis(city.kpis, co1, co1.filter((r) => r.city === 'KL' || r.city === null || r.city === ''), null);
  });

  test('a second-level filter narrows the pills too (and reads the view)', async () => {
    const f = await runKpis(params({ f: ['orderDate:between:2026-08-01~2026-08-31'] }), 1, null);
    const inAug = co1.filter((r) => r.so_date >= '2026-08-01' && r.so_date <= '2026-08-31');
    expectKpis(f.kpis, inAug, inAug, null);
    expect(f.headerRowsSql.counts.text).toContain('FROM scm."mfg_sales_orders_with_payment_totals"');
  });

  test("a rep's sales scope admits their orders and open-to-all orders only; another company never", async () => {
    const rep = await runKpis(params({}), 1, [REP]);
    expectKpis(rep.kpis, co1.filter(inScopeRep), co1.filter(inScopeRep), null);
    const two = await runKpis(params({}), 2, null);
    const co2 = ORDERS.filter((r) => r.company_id === 2);
    expectKpis(two.kpis, co2, co2, null);
  });

  test('a computed field (line warehouses) filters and selects through its function, as in PostgREST', async () => {
    const { where, values } = (() => {
      const p = new SqlParams();
      return { where: whereOf((q) => scopeToCompany(q, ctx(1)).overlaps('so_line_warehouse_ids', [WH]), p), values: p.values };
    })();
    const rows = await jsonRows<{ doc_no: string; so_line_warehouse_ids: string[] }>(sql,
      `SELECT t."doc_no", ${selectCol('so_line_warehouse_ids')} FROM scm.mfg_sales_orders_with_payment_totals t WHERE ${where} ORDER BY t.doc_no`, values);
    expect(rows).toEqual([{ doc_no: 'SO-B', so_line_warehouse_ids: [WH] }, { doc_no: 'SO-C', so_line_warehouse_ids: [WH] }]);
  });

  test('customers read: same rows, so_date newest first, company + sales scope', async () => {
    const st = soCustomerRowsStatement((q) => scopeToCompany(applySoScope(q, [REP]), ctx(1)));
    const rows = await jsonRows<{ doc_no: string; so_date: string; created_at: string; on_hold: boolean }>(sql, st.text, st.values);
    expect(rows.map((r) => r.doc_no).sort()).toEqual(co1.filter(inScopeRep).map((r) => r.doc_no).sort());
    expect(rows.map((r) => r.so_date)).toEqual([...rows.map((r) => r.so_date)].sort().reverse());
    /* PostgREST's own JSON: a date stays a date string, not a JS Date. */
    expect(typeof rows[0]!.so_date).toBe('string');
    expect(rows[0]!.so_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('funnel-values reads: every scoped order in doc_no order, book numbers only where linked', async () => {
    const st = soFunnelStatements(['doc_no', 'city', 'currency', 'paid_total_sen', 'balance_sen_live', 'so_line_warehouse_ids'], (q) => scopeToCompany(applySoScope(q, null), ctx(1)));
    const view = await jsonRows<{ doc_no: string; city: string | null; paid_total_sen: number }>(sql, st.view.text, st.view.values);
    expect(view.map((r) => r.doc_no)).toEqual(co1.map((r) => r.doc_no).sort());
    expect(view.find((r) => r.doc_no === 'SO-A')!.paid_total_sen).toBe(4_000);
    expect((view as unknown as Array<{ doc_no: string; so_line_warehouse_ids: string[] }>).find((r) => r.doc_no === 'SO-B')!.so_line_warehouse_ids).toEqual([WH]);
    const base = await jsonRows<{ doc_no: string; linked_ac_docno: string }>(sql, st.base.text, st.base.values);
    expect(base).toEqual([{ doc_no: 'SO-E', linked_ac_docno: 'AC-9' }]);
  });

  test('Purchase Invoice pills from one grouped statement equal the seven head counts', async () => {
    const st = statusCountsStatement('purchase_invoices', (q) => scopeToCompany(q, ctx(1)));
    const groups = await sql.unsafe(st.text, st.values);
    const counts = pillsFromGroups(groups as never, [
      ['all', 'all'], ['draft', PI_STATUS_BUCKETS.draft], ['posted', PI_STATUS_BUCKETS.posted], ['partial', PI_STATUS_BUCKETS.partial],
      ['paid', PI_STATUS_BUCKETS.paid], ['cancelled', PI_STATUS_BUCKETS.cancelled], ['on_hold', 'held'],
    ] as const);
    /* Head-count semantics: all = every company-1 row (the NULL status too);
       each bucket = exact status match; on_hold = marker OR legacy status. */
    expect(counts).toEqual({ all: 8, draft: 1, posted: 2, partial: 1, paid: 1, cancelled: 1, on_hold: 2 });
    expect(Object.keys(counts)).toEqual(['all', 'draft', 'posted', 'partial', 'paid', 'cancelled', 'on_hold']);
  });
});
