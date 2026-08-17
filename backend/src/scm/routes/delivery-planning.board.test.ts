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
import type { Env, Variables } from '../env';
import { deliveryPlanningBoardHandler } from './delivery-planning';

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
  local_total_centi: 100_000,
  balance_centi: 0,
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
