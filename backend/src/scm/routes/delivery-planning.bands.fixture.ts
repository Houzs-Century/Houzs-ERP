// TEST HELPER ONLY: one fixed Delivery Planning world for delivery-planning.bands.test.ts
// (open and delivered orders in every date band, both sides of today, band edges,
// an amended date, an undated order, another company, a driver's own jobs, ASSR, DP
// and project rows) and a request runner. Today is fixed at 2026-11-10 (Malaysia).
import { Hono } from 'hono';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

export const FIXED_NOW = new Date('2026-11-10T04:00:00Z'); // 12:00 Malaysia

const so = (docNo: string, status: string, date: string, extra: Row = {}): Row => ({
  doc_no: docNo, company_id: 1, debtor_code: 'C1', debtor_name: `Customer ${docNo}`, status, delivery_state: null,
  customer_state: 'Selangor', customer_country: 'Malaysia', customer_delivery_date: date, processing_date: date,
  local_total_sen: 100_000, balance_sen: 0, ...extra,
});
const line = (docNo: string): Row => ({
  id: `li-${docNo}`, doc_no: docNo, item_code: 'SOFA-1', item_group: 'SOFA', qty: 1, cancelled: false,
  // Not ready: SO-OPEN-1 (10 days out) is Pending Delivery, SO-OPEN-2 (2 days) is Overdue.
  stock_status: docNo === 'SO-OPEN-1' || docNo === 'SO-OPEN-2' ? 'PENDING' : 'READY', line_no: 1, created_at: '2026-01-01T00:00:00.000Z',
});
const dO = (id: string, docNo: string, status: string, deliveredAt: string | null, driverId: string | null = null): Row => ({
  id, do_number: `DO-${id}`, so_doc_no: docNo, status, driver_id: driverId, delivered_at: deliveredAt, company_id: 1,
  created_at: '2026-01-01T00:00:00.000Z',
});

export function fixtureTables(): Record<string, Row[]> {
  return {
    warehouses: [],
    drivers: [{ id: 'drv-1', user_id: 77 }],
    helpers: [],
    mfg_sales_orders: [
      so('SO-OPEN-1', 'CONFIRMED', '2026-11-20'),
      so('SO-OPEN-2', 'CONFIRMED', '2026-11-12'),
      so('SO-OPEN-OLD', 'CONFIRMED', '2025-02-01'),             // open, whatever its date: main board
      so('SO-DEL-RECENT', 'DELIVERED', '2026-11-05'),
      so('SO-DEL-15', 'DELIVERED', '2026-10-20'),               // DO 2026-10-25 17:30 UTC = 10-26 Malaysia: main
      so('SO-DEL-16', 'DELIVERED', '2026-10-20'),               // DO 2026-10-25 Malaysia: band 16-30
      so('SO-DEL-45', 'DELIVERED', '2026-09-26'),
      so('SO-DEL-75', 'DELIVERED', '2026-08-27'),
      so('SO-DEL-OLD', 'DELIVERED', '2025-06-01'),
      so('SO-DEL-LATE', 'DELIVERED', '2025-01-10'),             // old date, delivered 2026-11-08: main
      so('SO-DEL-NODO', 'DELIVERED', '2025-03-01'),             // no DO at all: by its own date, over 90
      so('SO-DEL-AMENDED', 'DELIVERED', '2025-03-01', { amended_delivery_date: '2026-09-20' }), // band 31-60
      so('SO-EDGE-15', 'CONFIRMED', '2026-10-26'),              // exactly 15 days ago: band 1
      so('SO-EDGE-16F', 'CONFIRMED', '2026-11-26'),             // 16 days ahead: band 2
      so('SO-FAR', 'CONFIRMED', '2027-03-01'),                  // over 90 days ahead: band 5
      so('SO-NODATE', 'CONFIRMED', '2026-11-01', { customer_delivery_date: null }), // processing date only: band 5
      so('SO-AMEND-NEAR', 'CONFIRMED', '2025-01-01', { amended_delivery_date: '2026-11-11' }), // amended wins: band 1
      so('SO-CO2-DEL', 'DELIVERED', '2025-05-05', { company_id: 2 }),
      so('SO-CO2-OPEN', 'CONFIRMED', '2026-11-15', { company_id: 2 }),
    ],
    mfg_sales_order_items: ['SO-EDGE-15', 'SO-EDGE-16F', 'SO-FAR', 'SO-NODATE', 'SO-AMEND-NEAR', 'SO-OPEN-1', 'SO-OPEN-2', 'SO-OPEN-OLD', 'SO-DEL-RECENT', 'SO-DEL-15', 'SO-DEL-16', 'SO-DEL-45', 'SO-DEL-75', 'SO-DEL-OLD', 'SO-DEL-LATE', 'SO-DEL-NODO', 'SO-DEL-AMENDED', 'SO-CO2-DEL', 'SO-CO2-OPEN'].map(line),
    delivery_order_items: [],
    mfg_sales_orders_with_payment_totals: [{ doc_no: 'SO-DEL-45', balance_sen_live: 777 }, { doc_no: 'SO-OPEN-1', balance_sen_live: 5000 }],
    delivery_orders: [
      dO('d-open2', 'SO-OPEN-2', 'ISSUED', null),
      dO('d-recent', 'SO-DEL-RECENT', 'DELIVERED', '2026-11-05T03:00:00Z'),
      dO('d-15', 'SO-DEL-15', 'DELIVERED', '2026-10-25T17:30:00Z'),
      dO('d-16', 'SO-DEL-16', 'DELIVERED', '2026-10-25T03:00:00Z'),
      dO('d-45', 'SO-DEL-45', 'DELIVERED', '2026-09-26T03:00:00Z'),
      dO('d-75', 'SO-DEL-75', 'DELIVERED', '2026-08-27T03:00:00Z'),
      dO('d-old', 'SO-DEL-OLD', 'DELIVERED', '2025-06-02T03:00:00Z', 'drv-1'),
      dO('d-late-1', 'SO-DEL-LATE', 'DELIVERED', '2025-01-10T03:00:00Z'),
      dO('d-late-2', 'SO-DEL-LATE', 'DELIVERED', '2026-11-08T03:00:00Z'),
      dO('d-co2', 'SO-CO2-DEL', 'DELIVERED', '2025-05-06T03:00:00Z'),
    ],
    delivery_order_crew: [
      { do_id: 'd-open2', driver_1_id: 'drv-1', driver_2_id: null, helper_1_id: null, helper_2_id: null, driver_1_name: 'Ali', driver_1_ic: null, driver_1_contact: null, driver_2_name: null, helper_1_name: null, helper_2_name: null, lorry_plate: 'VAA1' },
      { do_id: 'd-45', driver_1_id: 'drv-2', driver_2_id: null, helper_1_id: null, helper_2_id: null, driver_1_name: 'Bob', driver_1_ic: null, driver_1_contact: null, driver_2_name: null, helper_1_name: null, helper_2_name: null, lorry_plate: 'VBB2' },
    ],
    trip_stops: [],
    trips: [],
    dp_orders: [{
      id: 5, company_id: 1, dp_no: 'DP-1', job_type: 'SETUP', party_name: 'Setup Co', contact_phone: '012',
      address1: 'Jln Setup', address2: null, address3: null, address4: null, city: 'KL', postcode: '50000',
      state: 'Selangor', requested_date: '2026-11-12', status: 'PENDING', trip_id: null,
      so_doc_no: null, assr_case_id: null, do_id: null, delivery_message_status: null,
    }],
  };
}

/** c.env.DB for the ASSR and project unions (branched on the SQL, as in delivery-planning.board.test.ts). */
export const fixtureD1 = {
  prepare: (sql: string) => ({
    bind: () => fixtureD1.prepare(sql),
    first: async () => null,
    all: async () => ({
      results: /\bprojects\b/i.test(sql)
        ? [{ id: 10, code: 'PRJ-1', name: 'Expo', brand: 'AKEMI', venue: 'Hall 3', venue_address: 'Hall 3, KLCC', state: 'Selangor', company_id: 1, setup_start_at: '2026-11-14', dismantle_start_at: '2026-08-01', setup_crew: null, dismantle_crew: null, setup_driver_name: null, setup_lorry_plate: null, dismantle_driver_name: null, dismantle_lorry_plate: null }]
        : [{ id: 1, assr_no: 'ASSR-001', company_id: 1, status: 'OPEN', customer_name: 'A Customer', phone: '011', location: 'KL', customer_pickup_at: null, inspection_visit_at: null, inspection_by: null, do_date: '2026-11-15', addr1: '1 Jln', addr2: null, addr3: null, addr4: null, so_state: 'Selangor', so_postcode: '40000', so_country: 'Malaysia' }],
    }),
  }),
};

export type Caller = 'office' | 'driver';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the handler under test, old or new
export async function runBoard(handler: any, caller: Caller, qs: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const sb = fakeSb(fixtureTables());
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('supabase', sb as unknown as Variables['supabase']);
    c.set('companyId', 1 as Variables['companyId']);
    c.set('allowedCompanyIds', [1] as Variables['allowedCompanyIds']);
    c.set('user', { id: 'u1' } as unknown as Variables['user']);
    c.set('houzsUser', (caller === 'office'
      ? { id: 9, name: 'Dispatcher', permissions_set: new Set(['*']) }
      : { id: 77, name: 'Ali', position_name: 'Driver', permissions_set: new Set(['scm.transportation.drivers.view']) }) as unknown as Variables['houzsUser']);
    await next();
  });
  app.get('/delivery-planning', handler); // company-scope: test harness mounting the real board handler, which scopes itself
  app.onError((e, c) => c.json({ thrown: String((e as Error).stack ?? e).slice(0, 600) }, 500));
  const res = await app.request(`/delivery-planning${qs}`, undefined, { DB: fixtureD1 } as unknown as Env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
