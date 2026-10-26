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

/** One non-cancelled line per SO, so the delivered-sum engine gets past its
 *  "no lines -> nothing to do" early return and actually runs the read under
 *  test. */
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

/** A query builder that swallows every chained call and resolves to the error
 *  production actually returned: no rows, and an error object with NO usable
 *  message. `missing` cannot express this — its 42703 always has text — and the
 *  blank message is the whole regression. */
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
  /** Columns a table does NOT have — asking for one fails that whole read, the
   *  way PostgREST does. Used to break the delivered-sum read on purpose. */
  missing?: Record<string, string[]>;
  /** Fail the delivered-sum read with a BLANK driver message instead. */
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
      // Wildcard -> resolveDeliveryScope returns `all`, so the row scope is not
      // what these assertions are measuring.
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
    // The whole point: the operator can name the failing step.
    expect(body.stage).toBe('delivered_sum');
    expect(body.orders).toBeUndefined();
  });

  it('does not put the raw driver text in front of the operator', async () => {
    const app = harness({ missing: { delivery_order_items: ['so_item_id'] } });
    const { body } = await get(app);

    // The real cause ("column delivery_order_items.so_item_id does not exist",
    // 42703) belongs in the log, never in the response.
    expect(body.reason).toBeTruthy();
    expect(body.reason).not.toMatch(/42703|does not exist|delivery_order_items/);
    // The SCM client discards any server message of 200 characters or more.
    expect((body.reason ?? '').length).toBeLessThan(200);
  });

  /* THE PRODUCTION SHAPE. `wrangler tail` on 2026-08-17 printed
     `[onError] Error: delivered-sum read failed:` — the driver's message was the
     empty string, so the throw carried nothing and the client got the generic
     "Something went wrong". Both halves are pinned here. */
  it('is still diagnosable when the driver error has NO message at all', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = harness({ blankErrorOn: 'delivery_order_items' });
    const { status, body } = await get(app);
    const logged = spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    spy.mockRestore();

    expect(status).toBe(500);
    expect(body.stage).toBe('delivered_sum');
    // Never again a bare colon: the log names the blank AND the list size.
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

  /* The UNRESOLVED sentinel (companies master unreadable / cold start) must
     still degrade to no predicate — collapsing it into [] would empty the board
     for everyone. Same three-state contract lib/companyScope.ts states. */
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
        soLinked('HC-SO-2608-001', 'SO-000111', '2026-06-30'), // linked; book expiry + a frozen original date
        soLinked('HC-SO-2608-002', 'SO-000222'), // linked, book has NO expiry
        soLinked('HC-SO-2608-003', null),        // not in AutoCount at all
      ],
      mfg_sales_order_items: [line('HC-SO-2608-001', 'li-1'), line('HC-SO-2608-002', 'li-2'), line('HC-SO-2608-003', 'li-3')],
      delivery_order_items: [],
      delivery_orders: [],
      /* The AutoCount mirror (public schema). SO-000111 carries the exemption
         expiry; SO-000222 is in the book but carries none. */
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
    expect(byDoc['HC-SO-2608-001']).toBe('2026-12-31'); // the real exemption date, NOT the delivery date 2026-09-01
    expect(byDoc['HC-SO-2608-002']).toBeNull();          // linked but the book carries no expiry
    expect(byDoc['HC-SO-2608-003']).toBeNull();          // not in AutoCount
  });

  /* Owner 2026-10-22: the board also carries the FROZEN original delivery date
     (sales_exemption_expiry) so the frontend's "Sales Exemption Expiry Date"
     column can show it via soExemptionExpiryOf — the SAME value the SO list shows. */
  it('carries the frozen original delivery date (sales_exemption_expiry) on the SO row', async () => {
    const res = await build().request('/delivery-planning');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orders?: Array<{ so_doc_no: string; sales_exemption_expiry?: string | null }> };
    const byDoc = Object.fromEntries((body.orders ?? []).map((o) => [o.so_doc_no, o.sales_exemption_expiry ?? null]));
    expect(byDoc['HC-SO-2608-001']).toBe('2026-06-30'); // the frozen original, independent of the book expiry 2026-12-31
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
      // The live-balance read (a VIEW keyed by doc_no); 4242 is a value nothing
      // else in the fixture could produce, so reading it back proves the wiring.
      mfg_sales_orders_with_payment_totals: [{ doc_no: 'HC-SO-2608-001', balance_sen_live: 4242 }],
      delivery_order_items: [],
      // A committed DO with a distinctive number; status is non-DRAFT/CANCELLED so
      // it is kept and surfaces on the row.
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

/* The THREE non-SO sub-boards — ASSR legs, manual DP jobs, PMS project windows —
   are unioned onto the board after the SO rows. The shared harness above seeds no
   ASSR/DP/project data and gives no c.env.DB, so those reads fail-silent and the
   paths went UNTESTED. This fixture exercises all three so the board's open-time
   read parallelisation (kickOffSubBoardReads) can be proven output-preserving: a
   fake D1 feeds the ASSR union + project reads (branched by SQL), and dp_orders is
   seeded on the scm client. Each row kind must surface with its key fields. */
describe('GET /delivery-planning — the ASSR / DP / project sub-boards union onto the board', () => {
  // A minimal D1-shim: the handler calls c.env.DB.prepare(sql).all<T>() for the
  // ASSR union and the project union. Branch on the SQL so each read gets its own
  // rows; everything the processing reads is present, the rest is null.
  const fakeD1 = {
    prepare: (sql: string) => ({
      all: async () => ({
        results: /\bprojects\b/i.test(sql)
          ? [{
              id: 10, code: 'PRJ-1', name: 'Expo Build', brand: 'AKEMI', venue: 'Hall 3', venue_address: 'Hall 3, KLCC',
              state: 'Selangor', setup_start_at: '2026-09-10', dismantle_start_at: null,
              // Crew lives in the per-phase JSON (the editor path); the scalar
              // driver/lorry are stale fallbacks that the JSON must override.
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
      // A manual DP job (no source doc) — the only sub-board read on the scm client.
      dp_orders: [{
        id: 5, company_id: 1, dp_no: 'DP-1', job_type: 'SETUP', party_name: 'Setup Co', contact_phone: '012',
        address1: 'Jln Setup', address2: null, address3: null, address4: null, city: 'KL', postcode: '50000',
        state: 'Selangor', requested_date: '2026-09-08', status: 'PENDING', trip_id: null,
        so_doc_no: null, assr_case_id: null, do_id: null,
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
    const body = (await res.json()) as { orders?: Array<{ row_type: string; so_doc_no: string; ref: string | null; dp_no: string | null; branding: string | null; delivery_state: string | null; customer_delivery_date: string | null; amended_delivery_date: string | null; crew: Crew }> };
    const byType = (t: string) => (body.orders ?? []).filter((o) => o.row_type === t);
    expect(byType('so').map((o) => o.so_doc_no)).toEqual(['HC-SO-2608-001']);
    expect(byType('assr')).toHaveLength(1);       // the fake ASSR union row, delivery leg
    expect(byType('dp').map((o) => o.dp_no)).toEqual(['DP-1']);
    expect(byType('project').map((o) => o.so_doc_no)).toEqual(['PRJ:10#SETUP']);
    // Branding column fills for a project leg from the PMS project's brand (read-only).
    expect(byType('project').map((o) => o.branding)).toEqual(['AKEMI']);
    // Owner 2026-10-21 — the Delivered tab shows every job type: a project window
    // whose date has already passed is done, while an OPEN service case is still
    // pending (and a dated DP job that is not yet delivered is pending too).
    expect(byType('project')[0]?.delivery_state).toBe('DELIVERED'); // setup 2026-09-10 is in the past
    // Owner 2026-10-26: Service's date is a request until Logistics confirms it.
    expect(byType('assr')[0]?.delivery_state).toBe('PENDING_SCHEDULE'); // OPEN case, nothing confirmed
    // Owner 2026-10-22: an ASSR row carries its SERVICE date in customer_delivery_date
    // (shown in the "Sales Exemption Expiry Date" column) and leaves "Delivery Date"
    // (amended_delivery_date) blank for admin to propose.
    expect(byType('assr')[0]?.customer_delivery_date).toBe('2026-09-05'); // the seeded do_date leg
    expect(byType('assr')[0]?.amended_delivery_date).toBeNull();
    // Crew (driver + phone, both helpers, lorry) is pulled from the per-phase crew
    // JSON and OVERRIDES the stale scalar driver/lorry fallback (Driver A / WXX1).
    const projCrew = byType('project')[0]?.crew;
    expect(projCrew?.driver_1_name).toBe('JSON Driver');
    expect(projCrew?.driver_1_contact).toBe('+60111');
    expect(projCrew?.helper_1_name).toBe('Helper One');
    expect(projCrew?.helper_2_name).toBe('Helper Two');
    expect(projCrew?.lorry_plate).toBe('VRH1');
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
  const base = { status: 'CONFIRMED', readiness: { isShipReady: false }, effectiveDD: '2026-10-27', today: '2026-10-26' };
  it('puts a not-ready (even overdue) order in Pending Schedule', () => {
    expect(derivePlanningState({ ...base, storedOverride: null, delivered: 0, remaining: 1 })).toBe('OVERDUE');
    expect(derivePlanningState({ ...base, storedOverride: 'PENDING_SCHEDULE', delivered: 0, remaining: 1 })).toBe('PENDING_SCHEDULE');
  });
  it('gives way to Delivered', () => {
    expect(derivePlanningState({ ...base, storedOverride: 'PENDING_SCHEDULE', delivered: 1, remaining: 0 })).toBe('DELIVERED');
  });
});

/* Owner 2026-10-26: 「如果进到来 pending schedule 就不要出去了」 - the board stamps an
   order the first time it reaches Pending Schedule, so a later stock move cannot
   drop it back to Pending Delivery / Overdue on its own. */
describe('GET /delivery-planning — an order that reaches Pending Schedule stays there', () => {
  it('stamps the override on a ready order, and only for the office view', async () => {
    const rows = { warehouses: [], mfg_sales_orders: [so('HC-SO-2608-001', 1)], mfg_sales_order_items: [soLine('HC-SO-2608-001', 'li-1')], delivery_order_items: [], delivery_orders: [] };
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
