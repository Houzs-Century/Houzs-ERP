// GET /api/scm/delivery-planning — the board, and the defect that made it
// answer `{"error":"Something went wrong. Please try again."}` in production on
// 2026-08-17 (index.ts's humanizeError final fallback: an exception THROWN past
// the handler, matching none of its known patterns).
//
// THE 500 WAS ANONYMOUS. Every read on this handler answers
// `{error:'load_failed', ...}` when it fails — except the delivered-sum step,
// which THROWS (lib/do-unlinked-coverage.ts, since #2355) and so escaped the
// handler entirely. The body named no stage, so locating it cost a production
// audit and a `wrangler tail`. These pin that a failed delivered-sum read now
// answers with a stage code, that the raw driver text does NOT reach the
// operator, and that a driver error with an EMPTY message is still diagnosable.
//
// THE BOARD ALSO READ EVERY COMPANY'S ORDERS. The SO header read carried no
// company predicate at all, while its sibling /geo read of the same table wraps
// scopeToAllowedCompanies. That is a leak in its own right — and it is also why
// the 500 reproduced identically in a 100-order tenant and a 2,726-order one:
// the doc list handed to every downstream read did not depend on who asked.
//
// Harness follows autocountOutboxRoute.test.ts: a bare Hono app whose middleware
// injects scm/lib/fake-postgrest's fakeSb plus a company context, mounting the
// EXPORTED handler (the supabaseAuth bridge cannot run here).
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import { docsEnteringPendingSchedule } from '../lib/pending-schedule-stays';
import type { Env, Variables } from '../env';
import { deliveryPlanningBoardHandler, derivePlanningState } from './delivery-planning';

const so = (docNo: string, companyId: number): Row => ({
  doc_no: docNo,
  company_id: companyId,
  debtor_code: 'C1',
  debtor_name: 'A Customer',
  status: 'CONFIRMED',
  delivery_state: null,
  customer_state: 'Selangor',
  customer_country: 'Malaysia',
  customer_delivery_date: '2026-09-01',
  processing_date: '2026-08-20',
  local_total_sen: 100_000,
  balance_sen: 0,
});

const soLine = (docNo: string, id: string): Row => ({
  id,
  doc_no: docNo,
  item_code: 'SOFA-1',
  item_group: 'SOFA',
  qty: 1,
  cancelled: false,
  stock_status: 'READY',
  line_no: 1,
  created_at: '2026-08-01T00:00:00.000Z',
});

function blankErrorBuilder(): unknown {
  const q: Record<string, unknown> = {};
  const self = new Proxy(q, {
    get: (_t, prop) =>
      prop === 'then'
        ? (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: { message: '', code: '', details: '', hint: '' } }).then(resolve)
        : () => self,
  });
  return self;
}

function harness(opts: {
  allowedCompanyIds?: number[];
  missing?: Record<string, string[]>;
  blankErrorOn?: string;
}) {
  const sb = fakeSb(
    {
      warehouses: [],
      mfg_sales_orders: [so('HC-SO-2608-001', 1), so('HC-SO-2608-002', 2)],
      mfg_sales_order_items: [soLine('HC-SO-2608-001', 'li-1'), soLine('HC-SO-2608-002', 'li-2')],
      delivery_order_items: [],
      delivery_orders: [],
    },
    opts.missing ?? {},
  );
  const client = opts.blankErrorOn
    ? { from: (t: string) => (t === opts.blankErrorOn ? blankErrorBuilder() : sb.from(t)) }
    : sb;
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('supabase', client as unknown as Variables['supabase']);
    c.set('companyId', 1 as Variables['companyId']);
    c.set('allowedCompanyIds', opts.allowedCompanyIds as Variables['allowedCompanyIds']);
    c.set('user', { id: 'u1' } as unknown as Variables['user']);
    c.set('houzsUser', {
      id: 9,
      name: 'Tester',
      permissions_set: new Set(['*']),
    } as unknown as Variables['houzsUser']);
    await next();
  });
  app.get('/delivery-planning', deliveryPlanningBoardHandler);
  return app;
}

interface Body {
  error?: string;
  stage?: string;
  reason?: string;
  orders?: Array<{ so_doc_no: string; company_code: string | null }>;
}

const get = async (app: ReturnType<typeof harness>, qs = '') => {
  const res = await app.request(`/delivery-planning${qs}`);
  return { status: res.status, body: (await res.json()) as Body };
};

describe('GET /delivery-planning — a failed read says which one', () => {
  it('answers load_failed + the stage code when the delivered-sum read fails', async () => {
    const app = harness({ missing: { delivery_order_items: ['so_item_id'] } });
    const { status, body } = await get(app);

    expect(status).toBe(500);
    expect(body.error).toBe('load_failed');
    expect(body.stage).toBe('delivered_sum');
    expect(body.orders).toBeUndefined();
  });

  it('does not put the raw driver text in front of the operator', async () => {
    const app = harness({ missing: { delivery_order_items: ['so_item_id'] } });
    const { body } = await get(app);

    expect(body.reason).toBeTruthy();
    expect(body.reason).not.toMatch(/42703|does not exist|delivery_order_items/);
    expect((body.reason ?? '').length).toBeLessThan(200);
  });

  it('is still diagnosable when the driver error has NO message at all', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = harness({ blankErrorOn: 'delivery_order_items' });
    const { status, body } = await get(app);
    const logged = spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    spy.mockRestore();

    expect(status).toBe(500);
    expect(body.stage).toBe('delivered_sum');
    expect(logged).toContain('message=<empty>');
    expect(logged).toMatch(/in_list_size=\d+/);
  });

  it('serves the board when that read is healthy', async () => {
    const { status, body } = await get(harness({}));

    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    expect((body.orders ?? []).map((o) => o.so_doc_no).sort()).toEqual([
      'HC-SO-2608-001',
      'HC-SO-2608-002',
    ]);
  });
});

describe('GET /delivery-planning — cross-company means GRANTED companies', () => {
  it('shows only the caller\'s companies, not every company on the platform', async () => {
    const { status, body } = await get(harness({ allowedCompanyIds: [2] }));

    expect(status).toBe(200);
    expect((body.orders ?? []).map((o) => o.so_doc_no)).toEqual(['HC-SO-2608-002']);
  });

  it('still widens to every granted company for a two-company caller', async () => {
    const { body } = await get(harness({ allowedCompanyIds: [1, 2] }));

    expect((body.orders ?? []).map((o) => o.so_doc_no).sort()).toEqual([
      'HC-SO-2608-001',
      'HC-SO-2608-002',
    ]);
  });

  it('degrades to no predicate when the company context is unresolved', async () => {
    const { body } = await get(harness({ allowedCompanyIds: undefined }));

    expect((body.orders ?? []).length).toBe(2);
  });
});

/* BUG-51 repoint (owner 2026-10-15): the board's "Sales Exemption Expiry Date"
   column shows the REAL AutoCount exemption expiry (public.sales_orders.expiry_date,
   via linked_ac_docno), not the customer delivery date. Self-contained harness (its
   own fake DB with the AutoCount mirror) so the shared harness above — whose SOs
   carry no linked_ac_docno and so never hit the mirror read — stays untouched. */
describe('GET /delivery-planning — Sales Exemption Expiry Date column', () => {
  const soLinked = (docNo: string, linkedAc: string | null, frozen: string | null = null): Row => ({
    doc_no: docNo, company_id: 1, debtor_code: 'C1', debtor_name: 'A Customer',
    status: 'CONFIRMED', delivery_state: null, customer_state: 'Selangor', customer_country: 'Malaysia',
    customer_delivery_date: '2026-09-01', sales_exemption_expiry: frozen, processing_date: '2026-08-20',
    local_total_sen: 100_000, balance_sen: 0, linked_ac_docno: linkedAc,
  });
  const line = (docNo: string, id: string): Row => ({
    id, doc_no: docNo, item_code: 'SOFA-1', item_group: 'SOFA', qty: 1, cancelled: false,
    stock_status: 'READY', line_no: 1, created_at: '2026-08-01T00:00:00.000Z',
  });
  const build = () => {
    const sb = fakeSb({
      warehouses: [],
      mfg_sales_orders: [
        soLinked('HC-SO-2608-001', 'SO-000111', '2026-06-30'),
        soLinked('HC-SO-2608-002', 'SO-000222'),
        soLinked('HC-SO-2608-003', null),
      ],
      mfg_sales_order_items: [line('HC-SO-2608-001', 'li-1'), line('HC-SO-2608-002', 'li-2'), line('HC-SO-2608-003', 'li-3')],
      delivery_order_items: [],
      delivery_orders: [],
      sales_orders: [
        { doc_no: 'SO-000111', company_id: 1, expiry_date: '2026-12-31' },
        { doc_no: 'SO-000222', company_id: 1, expiry_date: null },
      ],
    });
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('supabase', sb as unknown as Variables['supabase']);
      c.set('companyId', 1 as Variables['companyId']);
      c.set('allowedCompanyIds', [1] as Variables['allowedCompanyIds']);
      c.set('user', { id: 'u1' } as unknown as Variables['user']);
      c.set('houzsUser', { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as unknown as Variables['houzsUser']);
      await next();
    });
    app.get('/delivery-planning', deliveryPlanningBoardHandler);
    return app;
  };

  it('shows the real AutoCount exemption expiry, blank off-book or when the book has none', async () => {
    const res = await build().request('/delivery-planning');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orders?: Array<{ so_doc_no: string; ac_sales_exemption_expiry?: string | null }> };
    const byDoc = Object.fromEntries((body.orders ?? []).map((o) => [o.so_doc_no, o.ac_sales_exemption_expiry ?? null]));
    expect(byDoc['HC-SO-2608-001']).toBe('2026-12-31');
    expect(byDoc['HC-SO-2608-002']).toBeNull();
    expect(byDoc['HC-SO-2608-003']).toBeNull();
  });

  /* Owner 2026-10-22: the board also carries the FROZEN original delivery date
     (sales_exemption_expiry) so the frontend's "Sales Exemption Expiry Date"
     column can show it via soExemptionExpiryOf — the SAME value the SO list shows. */
  it('carries the frozen original delivery date (sales_exemption_expiry) on the SO row', async () => {
    const res = await build().request('/delivery-planning');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orders?: Array<{ so_doc_no: string; sales_exemption_expiry?: string | null }> };
    const byDoc = Object.fromEntries((body.orders ?? []).map((o) => [o.so_doc_no, o.sales_exemption_expiry ?? null]));
    expect(byDoc['HC-SO-2608-001']).toBe('2026-06-30');
    expect(byDoc['HC-SO-2608-002']).toBeNull();
    expect(byDoc['HC-SO-2608-003']).toBeNull();
  });
});

/* OPEN-TIME parallel reads (owner 2026-10-20): the live-balance, line, deliverable
   and DO reads were made concurrent (each kicked off together, awaited at its
   original site) to cut the board's open latency. The one risk that refactor adds
   is a read's result being wired to the wrong field. This pins that a distinctive
   balance value and a distinctive DO number each still land on their OWN row
   field — i.e. the balance read feeds balance_sen_live and the DO read feeds
   delivery_orders, not swapped. Self-contained harness (seeds the payment-totals
   view + a DO the shared harness above omits). */
describe('GET /delivery-planning — concurrent per-SO reads wire to the right fields', () => {
  const build = () => {
    const sb = fakeSb({
      warehouses: [],
      mfg_sales_orders: [so('HC-SO-2608-001', 1)],
      mfg_sales_order_items: [soLine('HC-SO-2608-001', 'li-1')],
      mfg_sales_orders_with_payment_totals: [{ doc_no: 'HC-SO-2608-001', balance_sen_live: 4242 }],
      delivery_order_items: [],
      delivery_orders: [{ id: 'do-1', do_number: 'HC-DO-9999', so_doc_no: 'HC-SO-2608-001', status: 'ISSUED' }],
      delivery_order_crew: [],
    });
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('supabase', sb as unknown as Variables['supabase']);
      c.set('companyId', 1 as Variables['companyId']);
      c.set('allowedCompanyIds', [1] as Variables['allowedCompanyIds']);
      c.set('user', { id: 'u1' } as unknown as Variables['user']);
      c.set('houzsUser', { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as unknown as Variables['houzsUser']);
      await next();
    });
    app.get('/delivery-planning', deliveryPlanningBoardHandler);
    return app;
  };

  it('keeps the live balance and the DO on their own fields', async () => {
    const res = await build().request('/delivery-planning');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      orders?: Array<{ so_doc_no: string; balance_sen_live: number | null; delivery_orders: Array<{ do_number: string }> }>;
    };
    const row = (body.orders ?? []).find((o) => o.so_doc_no === 'HC-SO-2608-001');
    expect(row).toBeDefined();
    expect(row?.balance_sen_live).toBe(4242);
    expect((row?.delivery_orders ?? []).map((d) => d.do_number)).toEqual(['HC-DO-9999']);
  });
});

describe('GET /delivery-planning — the ASSR / DP / project sub-boards union onto the board', () => {
  const fakeD1 = {
    prepare: (sql: string) => ({
      all: async () => ({
        results: /\bprojects\b/i.test(sql)
          ? [{
              id: 10, code: 'PRJ-1', name: 'Expo Build', brand: 'AKEMI', venue: 'Hall 3', venue_address: 'Hall 3, KLCC',
              state: null, setup_start_at: '2026-09-10', dismantle_start_at: null,
              venue_postcode: '50088', venue_city: 'Kuala Lumpur', venue_state: 'Selangor',
              setup_crew: JSON.stringify({
                lorry_crew: [{ plate: 'VRH1', drivers: [{ name: 'JSON Driver', phone: '+60111' }], helpers: [{ name: 'Helper One', phone: '+60122' }, { name: 'Helper Two', phone: '+60133' }] }],
              }),
              dismantle_crew: null,
              setup_driver_name: 'Driver A', setup_lorry_plate: 'WXX1', dismantle_driver_name: null, dismantle_lorry_plate: null,
            }]
          : [{
              id: 1, assr_no: 'ASSR-001', company_id: 1, status: 'OPEN', customer_name: 'A Customer',
              phone: '011', location: 'KL', customer_pickup_at: null, inspection_visit_at: null,
              inspection_by: null, do_date: '2026-09-05', addr1: '1 Jln', addr2: null, addr3: null, addr4: null,
              so_state: 'Selangor', so_postcode: '40000', so_country: 'Malaysia',
              // Hand-set message status (owner 2026-10-29) — surfaces on the row,
              // and survives here because the fake has no wa_message_log to overlay.
              delivery_message_status: 'Pending Customer Reply (D)',
            }],
      }),
    }),
  };
  const build = () => {
    const sb = fakeSb({
      warehouses: [],
      mfg_sales_orders: [so('HC-SO-2608-001', 1)],
      mfg_sales_order_items: [soLine('HC-SO-2608-001', 'li-1')],
      delivery_order_items: [],
      delivery_orders: [],
      dp_orders: [{
        id: 5, company_id: 1, dp_no: 'DP-1', job_type: 'SETUP', party_name: 'Setup Co', contact_phone: '012',
        address1: 'Jln Setup', address2: null, address3: null, address4: null, city: 'KL', postcode: '50000',
        state: 'Selangor', requested_date: '2026-09-08', status: 'PENDING', trip_id: null,
        so_doc_no: null, assr_case_id: null, do_id: null,
        from_name: 'KL Warehouse',
        // Hand-set message status (owner 2026-10-29) — surfaces on the DP row.
        delivery_message_status: 'To Send Delivery Date',
      }],
    });
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('supabase', sb as unknown as Variables['supabase']);
      c.set('companyId', 1 as Variables['companyId']);
      c.set('allowedCompanyIds', [1] as Variables['allowedCompanyIds']);
      c.set('user', { id: 'u1' } as unknown as Variables['user']);
      c.set('houzsUser', { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as unknown as Variables['houzsUser']);
      await next();
    });
    app.get('/delivery-planning', deliveryPlanningBoardHandler);
    return app;
  };

  it('shows one SO row plus an ASSR, a DP and a project row', async () => {
    const res = await build().request('/delivery-planning', undefined, { DB: fakeD1 } as never);
    expect(res.status).toBe(200);
    type Crew = { driver_1_name: string | null; driver_1_contact: string | null; helper_1_name: string | null; helper_2_name: string | null; lorry_plate: string | null } | null;
    const body = (await res.json()) as { orders?: Array<{ row_type: string; so_doc_no: string; ref: string | null; dp_no: string | null; branding: string | null; delivery_state: string | null; customer_delivery_date: string | null; amended_delivery_date: string | null; delivery_message_status: string | null; crew: Crew }> };
    const byType = (t: string) => (body.orders ?? []).filter((o) => o.row_type === t);
    expect(byType('so').map((o) => o.so_doc_no)).toEqual(['HC-SO-2608-001']);
    expect(byType('assr')).toHaveLength(1);
    expect(byType('dp').map((o) => o.dp_no)).toEqual(['DP-1']);
    expect(byType('dp').map((o) => (o as unknown as { dp_from_name: string | null }).dp_from_name)).toEqual(['KL Warehouse']);
    expect(byType('project').map((o) => o.so_doc_no)).toEqual(['PRJ:10#SETUP']);
    expect(byType('project').map((o) => o.branding)).toEqual(['AKEMI']);
    // Owner 2026-11-17: a project leg carries the venue master's Postcode / City,
    // and its State when the project has none.
    const prj = byType('project')[0] as unknown as { postcode: string | null; customer_state: string | null; address: string | null };
    expect(prj.postcode).toBe('50088');
    expect(prj.customer_state).toBe('Selangor');
    expect(prj.address).toBe('Hall 3, KLCC, Kuala Lumpur, 50088');
    // Owner 2026-10-21 — the Delivered tab shows every job type: a project window
    // whose date has already passed is done, while an OPEN service case is still
    // pending (and a dated DP job that is not yet delivered is pending too).
    expect(byType('project')[0]?.delivery_state).toBe('DELIVERED');
    // Owner 2026-10-26: Service's date is a request until Logistics confirms it.
    expect(byType('assr')[0]?.delivery_state).toBe('PENDING_SCHEDULE');
    // Owner 2026-10-22: an ASSR row carries its SERVICE date in customer_delivery_date
    // (shown in the "Sales Exemption Expiry Date" column) and leaves "Delivery Date"
    // (amended_delivery_date) blank for admin to propose.
    expect(byType('assr')[0]?.customer_delivery_date).toBe('2026-09-05');
    expect(byType('assr')[0]?.amended_delivery_date).toBeNull();
    const projCrew = byType('project')[0]?.crew;
    expect(projCrew?.driver_1_name).toBe('JSON Driver');
    expect(projCrew?.driver_1_contact).toBe('+60111');
    expect(projCrew?.helper_1_name).toBe('Helper One');
    expect(projCrew?.helper_2_name).toBe('Helper Two');
    expect(projCrew?.lorry_plate).toBe('VRH1');
    // Owner 2026-10-29: the non-SO job types carry the message status too — a DP
    // job from its own column, a service case from assr_cases (the overlay leaves
    // it when there is no WhatsApp reply to supersede it).
    expect(byType('dp')[0]?.delivery_message_status).toBe('To Send Delivery Date');
    expect(byType('assr')[0]?.delivery_message_status).toBe('Pending Customer Reply (D)');
  });
});

/* Owner 2026-10-26: 7 of 2,331 SOs came back twice (and as many not at all). The
   header read paged on customer_delivery_date alone, which ties, so pages overlapped. */
describe('GET /delivery-planning — the SO header read pages on a total order', () => {
  it('orders by doc_no after the delivery date', async () => {
    const orders: string[] = [];
    const sb = fakeSb({
      warehouses: [], mfg_sales_orders: [so('HC-SO-2608-001', 1)],
      mfg_sales_order_items: [soLine('HC-SO-2608-001', 'li-1')], delivery_order_items: [], delivery_orders: [],
    }, {});
    const spy = (q: Record<string, unknown>): unknown => new Proxy(q, {
      get: (t, prop) => {
        const v = (t as Record<string | symbol, unknown>)[prop];
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          if (prop === 'order') orders.push(String(args[0]));
          const r = (v as (...a: unknown[]) => unknown).apply(t, args);
          return r === t ? spy(t) : r;
        };
      },
    });
    const client = { from: (t: string) => (t === 'mfg_sales_orders' ? spy(sb.from(t) as unknown as Record<string, unknown>) : sb.from(t)) };
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('supabase', client as unknown as Variables['supabase']);
      c.set('companyId', 1 as Variables['companyId']);
      c.set('user', { id: 'u1' } as unknown as Variables['user']);
      c.set('houzsUser', { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as unknown as Variables['houzsUser']);
      await next();
    });
    app.get('/delivery-planning', deliveryPlanningBoardHandler);
    expect((await app.request('/delivery-planning')).status).toBe(200);
    expect(orders.slice(0, 2)).toEqual(['customer_delivery_date', 'doc_no']);
  });
});

/* Owner 2026-10-26: right-click "Move to Pending Schedule" arranges an order before
   its goods are ready; once it is delivered it must still leave the queue. */
describe('derivePlanningState — a manual Pending Schedule', () => {
  const base = { status: 'CONFIRMED', readiness: { isShipReady: false }, effectiveDD: '2026-10-26', amendedDD: null, salesExemptionExpiry: null, today: '2026-10-26' };
  it('puts a not-ready (even overdue) order in Pending Schedule', () => {
    expect(derivePlanningState({ ...base, storedOverride: null, delivered: 0, remaining: 1 })).toBe('OVERDUE');
    expect(derivePlanningState({ ...base, storedOverride: 'PENDING_SCHEDULE', delivered: 0, remaining: 1 })).toBe('PENDING_SCHEDULE');
  });
  it('gives way to Delivered', () => {
    expect(derivePlanningState({ ...base, storedOverride: 'PENDING_SCHEDULE', delivered: 1, remaining: 0 })).toBe('DELIVERED');
  });
});

/* Owner 2026-11-10: an order is Overdue only once its delivery day has arrived,
   not 3 days early. The SQL board path must mirror `daysLeft <= 0`. */
describe('derivePlanningState — Overdue starts on the delivery day', () => {
  const notReady = { storedOverride: null, status: 'CONFIRMED', readiness: { isShipReady: false }, delivered: 0, remaining: 1, amendedDD: null, salesExemptionExpiry: null, today: '2026-11-10' };
  it('due in 3 days and not ready is Pending Delivery', () => {
    expect(derivePlanningState({ ...notReady, effectiveDD: '2026-11-13' })).toBe('PENDING_DELIVERY');
    expect(derivePlanningState({ ...notReady, effectiveDD: '2026-11-11' })).toBe('PENDING_DELIVERY');
  });
  it('due today and not ready is Overdue', () => {
    expect(derivePlanningState({ ...notReady, effectiveDD: '2026-11-10' })).toBe('OVERDUE');
  });
  it('due yesterday and not ready is Overdue', () => {
    expect(derivePlanningState({ ...notReady, effectiveDD: '2026-11-09' })).toBe('OVERDUE');
  });
  it('a ready order is Pending Schedule whatever the date', () => {
    for (const effectiveDD of ['2026-11-09', '2026-11-10', '2026-11-13']) {
      expect(derivePlanningState({ ...notReady, readiness: { isShipReady: true }, effectiveDD })).toBe('PENDING_SCHEDULE');
    }
  });
  it('a stored manual override still wins', () => {
    expect(derivePlanningState({ ...notReady, storedOverride: 'PENDING_DELIVERY', effectiveDD: '2026-11-09' })).toBe('PENDING_DELIVERY');
    expect(derivePlanningState({ ...notReady, storedOverride: 'OVERDUE', effectiveDD: '2026-11-13' })).toBe('OVERDUE');
  });
});

/* Owner 2026-11-17: ready goes to Pending Schedule whatever the dates; Overdue is
   NOT ready once the day it should be delivered has come. That day is the
   customer's amended date, else the Sales Exemption Expiry, never the current
   customer date alone (the HC Delivery sheet pushes it to today+3 every morning).
   HC-SO-012900: expiry 2026-10-26, amended 2026-11-27, date pushed to 2026-11-19. */
describe('derivePlanningState: Overdue is not ready on or past the due day', () => {
  const o = { storedOverride: null, status: 'IN_PRODUCTION', readiness: { isShipReady: false }, delivered: 0, remaining: 1, effectiveDD: '2026-11-19', amendedDD: null, today: '2026-11-17' };
  it('not ready, the original promise passed, the date only pushed by the sheet: Overdue', () => {
    expect(derivePlanningState({ ...o, salesExemptionExpiry: '2026-10-26' })).toBe('OVERDUE');
  });
  it('ready: Pending Schedule, even with the promise passed', () => {
    expect(derivePlanningState({ ...o, readiness: { isShipReady: true }, salesExemptionExpiry: '2026-10-26' })).toBe('PENDING_SCHEDULE');
  });
  it('not ready, the customer moved it to a later day: Pending Delivery until that day', () => {
    expect(derivePlanningState({ ...o, amendedDD: '2026-11-27', effectiveDD: '2026-11-27', salesExemptionExpiry: '2026-10-26' })).toBe('PENDING_DELIVERY');
    expect(derivePlanningState({ ...o, amendedDD: '2026-11-17', effectiveDD: '2026-11-17', salesExemptionExpiry: '2026-10-26' })).toBe('OVERDUE');
  });
  it('the due day itself counts', () => {
    expect(derivePlanningState({ ...o, salesExemptionExpiry: '2026-11-17' })).toBe('OVERDUE');
    expect(derivePlanningState({ ...o, salesExemptionExpiry: '2026-11-18' })).toBe('PENDING_DELIVERY');
  });
  it('moved to Pending Schedule by staff: stays', () => {
    expect(derivePlanningState({ ...o, storedOverride: 'PENDING_SCHEDULE', salesExemptionExpiry: '2026-10-26' })).toBe('PENDING_SCHEDULE');
  });
  it('delivered: Delivered', () => {
    expect(derivePlanningState({ ...o, delivered: 1, remaining: 0, salesExemptionExpiry: '2026-10-26' })).toBe('DELIVERED');
  });
  it('no expiry and no amendment: the effective date', () => {
    expect(derivePlanningState({ ...o, salesExemptionExpiry: null })).toBe('PENDING_DELIVERY');
    expect(derivePlanningState({ ...o, effectiveDD: '2026-11-17', salesExemptionExpiry: null })).toBe('OVERDUE');
  });
  it('reads a timestamp expiry by its date', () => {
    expect(derivePlanningState({ ...o, salesExemptionExpiry: '2026-11-12T00:00:00.000Z' })).toBe('OVERDUE');
  });
});

describe('GET /delivery-planning — not ready past the due day is Overdue, ready is Pending Schedule, counts too', () => {
  const row = (docNo: string, extra: Row): Row => ({
    doc_no: docNo, company_id: 1, debtor_code: 'C1', debtor_name: 'A Customer', status: 'IN_PRODUCTION', delivery_state: null,
    customer_state: 'Selangor', customer_country: 'Malaysia', customer_delivery_date: '2026-12-20', sales_exemption_expiry: null,
    amended_delivery_date: null, processing_date: '2026-10-01', local_total_sen: 100_000, balance_sen: 0, linked_ac_docno: null, ...extra,
  });
  const line = (docNo: string, stock: string): Row => ({
    id: `li-${docNo}`, doc_no: docNo, item_code: 'SOFA-1', item_group: 'SOFA', qty: 1, cancelled: false,
    stock_status: stock, line_no: 1, created_at: '2026-08-01T00:00:00.000Z',
  });
  const run = async (qs: string) => {
    const sb = fakeSb({
      warehouses: [],
      mfg_sales_orders: [
        row('SO-AC', { linked_ac_docno: 'SO-000900' }),
        row('SO-AMENDED', { sales_exemption_expiry: '2026-10-26', amended_delivery_date: '2026-11-27' }),
        row('SO-READY', { sales_exemption_expiry: '2026-10-26', customer_delivery_date: '2026-11-27' }),
        row('SO-MOVED', { sales_exemption_expiry: '2026-10-26', delivery_state: 'PENDING_SCHEDULE' }),
        row('SO-AHEAD', { sales_exemption_expiry: '2026-12-01', customer_delivery_date: '2026-12-01' }),
      ],
      mfg_sales_order_items: [line('SO-AC', 'PENDING'), line('SO-AMENDED', 'PENDING'), line('SO-READY', 'READY'), line('SO-MOVED', 'PENDING'), line('SO-AHEAD', 'PENDING')],
      delivery_order_items: [],
      delivery_orders: [],
      sales_orders: [{ doc_no: 'SO-000900', company_id: 1, expiry_date: '2026-10-26' }],
    });
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('supabase', sb as unknown as Variables['supabase']);
      c.set('companyId', 1 as Variables['companyId']);
      c.set('allowedCompanyIds', [1] as Variables['allowedCompanyIds']);
      c.set('user', { id: 'u1' } as unknown as Variables['user']);
      c.set('houzsUser', { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as unknown as Variables['houzsUser']);
      await next();
    });
    app.get('/delivery-planning', deliveryPlanningBoardHandler);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-13T04:00:00Z'));
    try {
      const res = await app.request(`/delivery-planning${qs}`);
      expect(res.status).toBe(200);
      return (await res.json()) as { orders?: Array<{ so_doc_no: string; delivery_state: string }>; counts_by_region?: Record<string, Record<string, number>> };
    } finally { vi.useRealTimers(); }
  };

  it('rows: Overdue past the expiry the column shows; a staff move still wins', async () => {
    const body = await run('');
    const byDoc = Object.fromEntries((body.orders ?? []).map((o) => [o.so_doc_no, o.delivery_state]));
    expect(byDoc).toEqual({ 'SO-AC': 'OVERDUE', 'SO-AMENDED': 'PENDING_DELIVERY', 'SO-READY': 'PENDING_SCHEDULE', 'SO-MOVED': 'PENDING_SCHEDULE', 'SO-AHEAD': 'PENDING_DELIVERY' });
  });

  it('counts_only counts the same rows as Overdue', async () => {
    const body = await run('?counts_only=1');
    expect(body.counts_by_region?.ALL).toMatchObject({ OVERDUE: 1, PENDING_SCHEDULE: 2, PENDING_DELIVERY: 2 });
  });
});

/* Owner 2026-10-26: 「如果进到来 pending schedule 就不要出去了」 - the board stamps an
   order the first time it reaches Pending Schedule, so a later stock move cannot
   drop it back to Pending Delivery / Overdue on its own. */
describe('GET /delivery-planning — an order that reaches Pending Schedule stays there', () => {
  it('stamps the override on a ready order, and only for the office view', async () => {
    // A delivery date far ahead: past the Sales Exemption Expiry the order is Overdue instead (owner 2026-11-13).
    const rows = { warehouses: [], mfg_sales_orders: [{ ...so('HC-SO-2608-001', 1), customer_delivery_date: '2099-01-01' }], mfg_sales_order_items: [soLine('HC-SO-2608-001', 'li-1')], delivery_order_items: [], delivery_orders: [] };
    const sb = fakeSb(rows, {});
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('supabase', sb as unknown as Variables['supabase']);
      c.set('companyId', 1 as Variables['companyId']);
      c.set('user', { id: 'u1' } as unknown as Variables['user']);
      c.set('houzsUser', { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as unknown as Variables['houzsUser']);
      await next();
    });
    app.get('/delivery-planning', deliveryPlanningBoardHandler);
    const body = (await (await app.request('/delivery-planning')).json()) as { orders: Array<{ so_doc_no: string; delivery_state: string; delivery_state_override: string | null }> };
    const row = body.orders.find((o) => o.so_doc_no === 'HC-SO-2608-001')!;
    expect(row.delivery_state).toBe('PENDING_SCHEDULE');
    expect(row.delivery_state_override).toBe('PENDING_SCHEDULE');
    const stored = await sb.from('mfg_sales_orders').select('doc_no, delivery_state').eq('doc_no', 'HC-SO-2608-001');
    expect((stored.data as Array<{ delivery_state: string | null }>)[0]?.delivery_state).toBe('PENDING_SCHEDULE');
  });

  it('only stamps SO rows that are in Pending Schedule without an override', () => {
    expect(docsEnteringPendingSchedule([
      { row_type: 'so', so_doc_no: 'A', delivery_state: 'PENDING_SCHEDULE', delivery_state_override: null },
      { row_type: 'so', so_doc_no: 'B', delivery_state: 'PENDING_DELIVERY', delivery_state_override: null },
      { row_type: 'so', so_doc_no: 'C', delivery_state: 'PENDING_SCHEDULE', delivery_state_override: 'PENDING_SCHEDULE' },
      { row_type: 'assr', so_doc_no: 'D#delivery', delivery_state: 'PENDING_SCHEDULE', delivery_state_override: null },
    ])).toEqual(['A']);
  });
});

describe('GET /delivery-planning?state=OPEN', () => {
  it('leaves a delivered order out of the rows and in the Delivered count', async () => {
    const delivered = { ...so('HC-SO-2608-009', 1), status: 'DELIVERED' };
    const sb = fakeSb({ warehouses: [], mfg_sales_orders: [so('HC-SO-2608-001', 1), delivered], mfg_sales_order_items: [soLine('HC-SO-2608-001', 'li-1'), soLine('HC-SO-2608-009', 'li-9')], delivery_order_items: [], delivery_orders: [] }, {});
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('supabase', sb as unknown as Variables['supabase']);
      c.set('companyId', 1 as Variables['companyId']);
      c.set('user', { id: 'u1' } as unknown as Variables['user']);
      c.set('houzsUser', { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as unknown as Variables['houzsUser']);
      await next();
    });
    app.get('/delivery-planning', deliveryPlanningBoardHandler);
    const open = (await (await app.request('/delivery-planning?state=OPEN')).json()) as { orders: Array<{ so_doc_no: string }>; counts: Record<string, number>; delivered_by_region: Record<string, number> };
    const all = (await (await app.request('/delivery-planning')).json()) as { counts: Record<string, number> };
    expect(open.orders.map((o) => o.so_doc_no)).toEqual(['HC-SO-2608-001']);
    expect(open.counts.DELIVERED).toBe(all.counts.DELIVERED);
    expect(open.counts.ALL).toBe(all.counts.ALL);
    expect(Object.values(open.delivered_by_region).reduce((a, b) => a + b, 0)).toBe(1);
  });
});

/* 2026-10-27, owner option A: after an edit the board re-reads only the edited
   order (?docs=) instead of the whole board. */
describe('GET /delivery-planning?docs=', () => {
  it('rebuilds only the named SO rows', async () => {
    const { status, body } = await get(harness({}), '?docs=HC-SO-2608-002');
    expect(status).toBe(200);
    expect((body.orders ?? []).map((o) => o.so_doc_no)).toEqual(['HC-SO-2608-002']);
  });
  it('an empty list reads nothing', async () => {
    const { body } = await get(harness({}), '?docs=');
    expect(body.orders).toEqual([]);
  });
});
