/* EXECUTES the Delivery Planning board's SQL path (scm/lib/delivery-board-sql.ts,
   DP_BOARD_SOURCE=sql) on real Postgres and holds it to the board as it was.

   1. The bands fixture (routes/delivery-planning.bands.fixture.ts) is written into
      Postgres; the handler, switched to sql, must answer every recorded case in
      routes/__fixtures__/dp-board-before.json (whole board, OPEN, a region, the
      driver's board, counts_only, the five bands together).
   2. A richer world (regions, a warehouse, the catalog, linked DO lines and a
      return, a trip stop with a DP number, a PO, an AutoCount expiry) is given to
      BOTH paths: the PostgREST path through the fake PostgREST, the SQL path through
      Postgres. Their SO rows must be identical.
   3. Shadow mode serves the old board and records zero differences.

   Timestamps: the fixture writes '...Z' literals that the fake PostgREST hands
   back verbatim; Postgres (and so real PostgREST) answers '+00:00'. Both sides are
   compared as instants, nothing else is normalised. */
import { readFileSync } from 'node:fs';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../src/db/pg', async (orig) => ({ ...(await orig<typeof import('../src/db/pg')>()), getSql: () => h.client }));
let client: Sql;

import before from '../src/scm/routes/__fixtures__/dp-board-before.json';
import { deliveryPlanningBoardHandler } from '../src/scm/routes/delivery-planning';
import { FIXED_NOW, fixtureTables, runBoard, type Caller } from '../src/scm/routes/delivery-planning.bands.fixture';
import type { Row } from '../src/scm/lib/fake-postgrest';

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

type Order = { so_doc_no: string; row_type: string } & Record<string, unknown>;
type Body = { orders: Order[]; counts: Record<string, number>; band?: { page_count: number }; counts_by_region?: Record<string, Record<string, number>> } & Record<string, unknown>;
const old = before as unknown as Record<string, Body>;

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
function instants(v: unknown): unknown {
  if (typeof v === 'string' && ISO_TS.test(v)) return new Date(v).toISOString();
  if (Array.isArray(v)) return v.map(instants);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, instants(x)]));
  return v;
}

const DDL = `
  DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF; END $$;
  CREATE SCHEMA IF NOT EXISTS scm;
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'scm' AND viewname = 'mfg_sales_orders_with_payment_totals') THEN DROP VIEW scm.mfg_sales_orders_with_payment_totals CASCADE; END IF;
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'scm' AND tablename = 'mfg_sales_orders_with_payment_totals') THEN DROP TABLE scm.mfg_sales_orders_with_payment_totals CASCADE; END IF;
  END $$;
  DROP TABLE IF EXISTS scm.delivery_planning_regions, scm.state_delivery_regions, scm.warehouses, scm.mfg_sales_orders,
    scm.mfg_sales_order_items, scm.mfg_products, scm.delivery_orders, scm.delivery_order_items, scm.delivery_returns,
    scm.delivery_return_items, scm.trip_stops, scm.trips, scm.delivery_order_crew, scm.purchase_order_items,
    scm.purchase_orders, scm.dp_test_balances, scm.delivery_board_shadow_runs, public.sales_orders CASCADE;
  CREATE TABLE scm.delivery_planning_regions (id text PRIMARY KEY, code text, name text, sort_order integer, active boolean, company_id bigint);
  CREATE TABLE scm.state_delivery_regions (id serial PRIMARY KEY, state_key text, country text, region_id text);
  CREATE TABLE scm.warehouses (id text PRIMARY KEY, code text, name text);
  CREATE TABLE scm.mfg_sales_orders (
    doc_no text PRIMARY KEY, company_id bigint NOT NULL, debtor_code text, debtor_name text, phone text, branding text,
    status text NOT NULL, delivery_state text, agent text, salesperson_id text, venue text, customer_state text, customer_country text,
    customer_delivery_date date, sales_exemption_expiry date, amend_date_from_customer date, amended_delivery_date date,
    amend_reason text, amend_reason_from_customer text, processing_date date, so_date date, address1 text, address2 text,
    postcode text, building_type text, local_total_sen integer, balance_sen integer, possession_date date, house_type text,
    replacement_disposal text, referral text, ref text, customer_so_no text, delivery_message_status text,
    disposal_request text, dp_remark text, linked_ac_docno text
  );
  CREATE TABLE scm.mfg_sales_order_items (
    id text PRIMARY KEY, doc_no text NOT NULL, company_id bigint, item_group text, item_code text, stock_status text,
    cancelled boolean DEFAULT false, warehouse_id text, branding text, created_at timestamptz, line_no integer, qty integer
  );
  CREATE TABLE scm.mfg_products (code text, category text, branding text, company_id bigint);
  CREATE TABLE scm.delivery_orders (
    id text PRIMARY KEY, do_number text, so_doc_no text, company_id bigint, status text NOT NULL, driver_id text, driver_name text,
    vehicle text, delivery_state text, customer_delivery_date date, do_date date, delivered_at timestamptz, pod_r2_key text,
    pod_lat double precision, time_range text, time_confirmed boolean, arrival_at timestamptz, departure_at timestamptz,
    shipout_date date, customer_delivered_date date, eta_arriving_port date, delivery_substatus text,
    arrives_em_warehouse_date date, em_delivery_status text, consignment_no text, vessel_voyage text, etd_port_klang date,
    bs_delivery_date date, esb_remarks text, bs_remarks text, ctn text, em_delivered_date date, created_at timestamptz
  );
  CREATE TABLE scm.delivery_order_items (id text PRIMARY KEY, delivery_order_id text, so_item_id text, item_code text, qty integer);
  CREATE TABLE scm.delivery_returns (id text PRIMARY KEY, status text);
  CREATE TABLE scm.delivery_return_items (id text PRIMARY KEY, delivery_return_id text, do_item_id text, qty_returned integer);
  CREATE TABLE scm.trip_stops (id serial PRIMARY KEY, dp_no text, do_id text, trip_id text, stop_no integer, eta_offset_s integer);
  CREATE TABLE scm.trips (id text PRIMARY KEY, trip_no text, trip_date date, status text);
  CREATE TABLE scm.delivery_order_crew (
    do_id text PRIMARY KEY, driver_1_id text, driver_2_id text, helper_1_id text, helper_2_id text, driver_1_name text,
    driver_1_ic text, driver_1_contact text, driver_2_name text, helper_1_name text, helper_2_name text, lorry_plate text
  );
  CREATE TABLE scm.purchase_order_items (id serial PRIMARY KEY, so_item_id text, purchase_order_id text, company_id bigint);
  CREATE TABLE scm.purchase_orders (id text PRIMARY KEY, po_number text, status text, company_id bigint);
  CREATE TABLE scm.dp_test_balances (doc_no text, balance_sen_live integer);
  CREATE VIEW scm.mfg_sales_orders_with_payment_totals AS SELECT doc_no, balance_sen_live FROM scm.dp_test_balances;
  CREATE TABLE public.sales_orders (doc_no text PRIMARY KEY, company_id bigint NOT NULL, expiry_date date);
`;

/* fake-PostgREST table -> Postgres table; an object-valued key (an embed the fake
   needs, e.g. `parent`) is not a column. */
const PG_TABLE: Record<string, string> = {
  delivery_planning_regions: 'scm.delivery_planning_regions', state_delivery_regions: 'scm.state_delivery_regions',
  warehouses: 'scm.warehouses', mfg_sales_orders: 'scm.mfg_sales_orders', mfg_sales_order_items: 'scm.mfg_sales_order_items',
  mfg_products: 'scm.mfg_products', delivery_orders: 'scm.delivery_orders', delivery_order_items: 'scm.delivery_order_items',
  delivery_returns: 'scm.delivery_returns', delivery_return_items: 'scm.delivery_return_items', trip_stops: 'scm.trip_stops',
  trips: 'scm.trips', delivery_order_crew: 'scm.delivery_order_crew', purchase_order_items: 'scm.purchase_order_items',
  purchase_orders: 'scm.purchase_orders', mfg_sales_orders_with_payment_totals: 'scm.dp_test_balances', sales_orders: 'public.sales_orders',
};

async function seed(s: Sql, tables: Record<string, Row[]>): Promise<void> {
  await s.unsafe(`TRUNCATE ${[...new Set(Object.values(PG_TABLE))].join(', ')}`);
  for (const [name, rows] of Object.entries(tables)) {
    const target = PG_TABLE[name];
    if (!target) continue; // read by the fake only (drivers, helpers, dp_orders)
    for (const r of rows) {
      const cols = Object.keys(r).filter((k) => r[k] === null || typeof r[k] !== 'object');
      await s.unsafe(`INSERT INTO ${target} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map((k) => r[k]) as never[]);
    }
  }
}

/* The fixture plus every dataset the fixture leaves empty. */
function richTables(): Record<string, Row[]> {
  const t = fixtureTables();
  const companyOf = new Map(t.mfg_sales_orders!.map((s) => [s.doc_no, s.company_id]));
  t.mfg_sales_order_items = t.mfg_sales_order_items!.map((i) => ({ ...i, company_id: companyOf.get(i.doc_no), warehouse_id: i.doc_no === 'SO-OPEN-1' ? 'wh-1' : null }));
  t.mfg_sales_order_items.push({ id: 'li-SO-OPEN-1-b', doc_no: 'SO-OPEN-1', company_id: 1, item_code: 'BED-9', item_group: 'BEDFRAME', qty: 2, cancelled: false, stock_status: 'READY', line_no: 2, created_at: '2026-01-01T00:00:00.000Z', warehouse_id: null, branding: null });
  t.delivery_planning_regions = [
    { id: 'r-kl', code: 'KL', name: 'KL/SEL', sort_order: 1, active: true, company_id: 1 },
    { id: 'r-n', code: 'NORTHERN', name: 'Northern', sort_order: 2, active: true, company_id: 1 },
  ];
  t.state_delivery_regions = [{ state_key: 'Selangor', country: 'Malaysia', region_id: 'r-kl' }, { state_key: 'Pulau Pinang', country: 'Malaysia', region_id: 'r-n' }];
  t.warehouses = [{ id: 'wh-1', code: ' KL1 ', name: 'KL Warehouse' }];
  t.mfg_products = [{ code: 'SOFA-1', category: 'sofa', branding: 'AKEMI', company_id: 1 }, { code: 'BED-9', category: 'BEDFRAME', branding: null, company_id: 1 }];
  /* Ready open orders already carry the Pending Schedule stamp the board writes on
     first sight (lib/pending-schedule-stays.ts): the served board stamps the fake
     PostgREST, not Postgres, so an unstamped world would differ only by that write. */
  const ready = (doc: string) => doc !== 'SO-OPEN-1' && doc !== 'SO-OPEN-2';
  t.mfg_sales_orders = t.mfg_sales_orders!.map((s) => ({
    ...s,
    ...(s.status === 'CONFIRMED' && ready(String(s.doc_no)) ? { delivery_state: 'PENDING_SCHEDULE' } : {}),
    ...(s.doc_no === 'SO-OPEN-2' ? { linked_ac_docno: ' AC-7 ', customer_state: 'Pulau Pinang' } : {}),
  }));
  t.sales_orders = [{ doc_no: 'AC-7', company_id: 1, expiry_date: '2026-12-31' }];
  /* Timestamps in the form Postgres (and real PostgREST) answers, so the fake-served
     board and the SQL rebuild can be compared byte for byte in shadow mode. */
  const pgTs = (v: unknown) => (typeof v === 'string' ? new Date(v).toISOString().replace('.000Z', '+00:00') : v);
  t.delivery_orders = t.delivery_orders!.map((d) => ({ ...d, delivered_at: pgTs(d.delivered_at) }));
  // SO-OPEN-1: one bedframe delivered on a DO, one of those returned; a DRAFT DO that must not count.
  t.delivery_orders = [...t.delivery_orders!,
    { id: 'd-open1', do_number: 'DO-d-open1', so_doc_no: 'SO-OPEN-1', status: 'DELIVERED', driver_id: null, delivered_at: '2026-11-09T05:00:00+00:00', company_id: 1, created_at: '2026-02-01T00:00:00.000Z', pod_lat: 3.1415, time_confirmed: true },
    { id: 'd-open1-draft', do_number: 'DO-draft', so_doc_no: 'SO-OPEN-1', status: 'DRAFT', driver_id: null, delivered_at: null, company_id: 1, created_at: '2026-03-01T00:00:00.000Z' },
  ];
  t.delivery_order_items = [
    { id: 'dl-1', delivery_order_id: 'd-open1', so_item_id: 'li-SO-OPEN-1-b', item_code: 'BED-9', qty: 2, parent: { status: 'DELIVERED' } },
    { id: 'dl-2', delivery_order_id: 'd-open1-draft', so_item_id: 'li-SO-OPEN-1', item_code: 'SOFA-1', qty: 1, parent: { status: 'DRAFT' } },
  ];
  t.delivery_returns = [{ id: 'ret-1', status: 'RECEIVED' }];
  t.delivery_return_items = [{ id: 'ri-1', delivery_return_id: 'ret-1', do_item_id: 'dl-1', qty_returned: 1, parent: { status: 'RECEIVED' } }];
  t.trip_stops = [{ dp_no: 'DP-77', do_id: 'd-open2', trip_id: 't-1', stop_no: 2, eta_offset_s: 600 }];
  t.trips = [{ id: 't-1', trip_no: 'TR-1', trip_date: '2026-11-12', status: 'PLANNED' }];
  t.purchase_order_items = [
    { so_item_id: 'li-SO-OPEN-1', purchase_order_id: 'po-10', company_id: 1 }, { so_item_id: 'li-SO-OPEN-1-b', purchase_order_id: 'po-9', company_id: 1 },
    { so_item_id: 'li-SO-OPEN-1', purchase_order_id: 'po-x', company_id: 1 },
  ];
  t.purchase_orders = [
    { id: 'po-10', po_number: 'PO-10', status: 'ISSUED', company_id: 1 }, { id: 'po-9', po_number: 'PO-9', status: 'DRAFT', company_id: 1 },
    { id: 'po-x', po_number: 'PO-1', status: 'CANCELLED', company_id: 1 },
  ];
  return t;
}

const warnings: string[] = [];
async function board(qs: string, source: string | null, caller: Caller = 'office', tables: Record<string, Row[]> = fixtureTables()): Promise<Body> {
  const r = await runBoard(deliveryPlanningBoardHandler, caller, qs, source, tables);
  expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
  return r.body as Body;
}

describePg('Delivery Planning board, SQL path on real Postgres', () => {
  beforeAll(async () => {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
    if (parsed.pathname !== '/houzs_test') throw new Error('PG integration tests require the disposable houzs_test database');
    client = postgres(url, { max: 1, onnotice: () => undefined, types: { bigint: { to: 20, from: [20], parse: (x: string) => Number(x), serialize: (x: number) => String(x) } } });
    h.client = client;
    await client.unsafe(DDL);
    await client.unsafe(readFileSync(new URL('../src/db/migrations-pg/20261111T0200_scm_delivery_board_shadow_runs.sql', import.meta.url), 'utf8'));
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(FIXED_NOW);
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.map(String).join(' ')); });
  });
  afterAll(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await client?.end(); });

  test('every recorded fixture case is identical (whole board, OPEN, region, driver, counts, bands)', async () => {
    await seed(client, fixtureTables());
    warnings.length = 0;
    expect(instants(await board('', 'sql'))).toEqual(instants(old.office_all));
    expect(instants(await board('?state=OPEN', 'sql'))).toEqual(instants(old.office_open));
    expect(instants(await board('?region=KL', 'sql'))).toEqual(instants(old.office_kl));
    expect(instants(await board('?region=ALL&state=ALL', 'sql', 'driver'))).toEqual(instants(old.driver_all));
    expect(instants(await board('?state=OPEN', 'sql', 'driver'))).toEqual(instants(old.driver_open));
    const counts = await board('?counts_only=1', 'sql');
    expect(counts.counts_by_region?.ALL).toEqual(old.office_all!.counts);
    expect(counts.counts_by_region?.KL).toEqual(old.office_kl!.counts);
    const union: Order[] = [];
    for (let band = 1; band <= 5; band += 1) {
      for (let page = 0, pages = 1; page < pages; page += 1) {
        const r = await board(`?band=${band}&page=${page}`, 'sql');
        union.push(...r.orders);
        pages = r.band?.page_count ?? 0;
      }
    }
    const byKey = (rows: Order[]) => Object.fromEntries(rows.map((o) => [`${o.row_type}:${o.so_doc_no}`, instants(o)]));
    expect(byKey(union)).toEqual(byKey(old.office_all!.orders));
    // The SQL statements ran: no request fell back to PostgREST.
    expect(warnings.filter((w) => w.includes('SQL'))).toEqual([]);
  });

  test('rich world: the SQL path builds the same SO rows as the PostgREST path', async () => {
    const tables = richTables();
    await seed(client, tables);
    warnings.length = 0;
    for (const [qs, caller] of [['', 'office'], ['?state=OPEN', 'office'], ['?band=1&page=0', 'office'], ['?region=NORTHERN', 'office'], ['?region=ALL&state=ALL', 'driver']] as Array<[string, Caller]>) {
      const rest = await board(qs, null, caller, richTables());
      const sql = await board(qs, 'sql', caller, richTables());
      expect(instants(sql), `${caller} ${qs}`).toEqual(instants(rest));
    }
    expect(warnings.filter((w) => w.includes('SQL'))).toEqual([]);
    // The rich data really reached the rows (a parity of empties would prove nothing).
    const open1 = (await board('', 'sql', 'office', tables)).orders.find((o) => o.so_doc_no === 'SO-OPEN-1')!;
    expect(open1).toMatchObject({ delivered_qty: 2, remaining_qty: 2, po_locked: true, po_nos: ['PO-9', 'PO-10'], warehouse_code: 'KL1', branding: expect.any(String) });
    const open2 = (await board('', 'sql', 'office', tables)).orders.find((o) => o.so_doc_no === 'SO-OPEN-2')!;
    expect(open2).toMatchObject({ dp_no: 'DP-77', trip_no: 'TR-1', trip_stop_no: 2, ac_sales_exemption_expiry: '2026-12-31', region: 'NORTHERN' });
  });

  test('shadow serves the old board and records a comparison with no differences', async () => {
    const tables = richTables();
    await seed(client, tables);
    const pending: Array<Promise<unknown>> = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => undefined, props: {} };
    const r = await runBoard(deliveryPlanningBoardHandler, 'office', '', 'shadow', richTables(), ctx);
    expect(r.status).toBe(200);
    expect(instants(r.body)).toEqual(instants(await board('', null, 'office', richTables())));
    await Promise.all(pending);
    const runs = await client<Array<{ compared: number; differing: number; error: string | null; diffs: unknown }>>`SELECT compared, differing, error, diffs FROM scm.delivery_board_shadow_runs ORDER BY id DESC LIMIT 1`;
    expect(runs[0]).toMatchObject({ differing: 0, error: null, diffs: [] });
    expect(runs[0]!.compared).toBeGreaterThan(10);
  });

  test('shadow records a real difference by doc number and field name only', async () => {
    const tables = richTables();
    await seed(client, tables);
    await client`UPDATE scm.mfg_sales_orders SET phone = '0199999999' WHERE doc_no = 'SO-OPEN-1'`; // Postgres now disagrees with the fake
    const pending: Array<Promise<unknown>> = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => undefined, props: {} };
    await runBoard(deliveryPlanningBoardHandler, 'office', '', 'shadow', richTables(), ctx);
    await Promise.all(pending);
    const [run] = await client<Array<{ differing: number; diffs: Array<{ doc_no: string; fields: string[] }> }>>`SELECT differing, diffs FROM scm.delivery_board_shadow_runs ORDER BY id DESC LIMIT 1`;
    expect(run).toMatchObject({ differing: 1, diffs: [{ doc_no: 'SO-OPEN-1', fields: ['phone'] }] });
    expect(JSON.stringify(run!.diffs)).not.toContain('0199999999');
  });
});
