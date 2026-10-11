import { Hono } from 'hono';
import { beforeEach, describe, expect, test } from 'vitest';
import { fairReportHandler, fairReportDetailHandler } from '../src/scm/routes/reports';

/* The Fair Report handlers driven END-TO-END through a bare Hono app whose own
   middleware INJECTS a fake scm supabase client + the real Houzs caller, and a
   c.env.DB stub for the public.projects lookup. Mounting the EXPORTED handlers
   (not the whole router) lets the test skip the supabaseAuth bridge, which
   cannot run in the harness — while still driving the REAL fairReportAccess gate,
   joins, money split and filters. */

const state = {
  houzsUser: undefined as any,
};

// ── Fake PostgREST query builder ─────────────────────────────────────────────
class FakeQuery {
  private preds: Array<(r: any) => boolean> = [];
  private _range: [number, number] | null = null;
  constructor(private rows: any[]) {}
  select() { return this; }
  order() { return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  in(col: string, vals: unknown[]) { const s = new Set(vals.map(String)); this.preds.push((r) => s.has(String(r[col]))); return this; }
  gte(col: string, val: any) { this.preds.push((r) => r[col] != null && r[col] >= val); return this; }
  lte(col: string, val: any) { this.preds.push((r) => r[col] != null && r[col] <= val); return this; }
  range(from: number, to: number) { this._range = [from, to]; return this; }
  private apply() {
    let out = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this._range) out = out.slice(this._range[0], this._range[1] + 1);
    return out;
  }
  maybeSingle() {
    const out = this.rows.filter((r) => this.preds.every((p) => p(r)));
    return Promise.resolve({ data: out[0] ?? null, error: null });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.apply(), error: null }).then(res, rej);
  }
}

type DataSet = Record<string, any[]>;
function fakeSupabase(data: DataSet) {
  return { from: (table: string) => new FakeQuery(data[table] ?? []) };
}

// ── Fake c.env.DB (public.projects) ──────────────────────────────────────────
function fakeDB(projects: any[]) {
  return {
    prepare(_sql: string) {
      return {
        bind(...args: any[]) {
          const ids = new Set(args.map(String));
          const results = projects.filter((p) => ids.has(String(p.id)));
          return { all: async () => ({ results }), first: async () => results[0] ?? null };
        },
      };
    },
  };
}

// ── Callers ──────────────────────────────────────────────────────────────────
const OWNER = { id: 1, position_name: null, permissions_set: new Set(['*']) };
const SUPER_ADMIN = { id: 2, position_name: 'Super Admin', permissions_set: new Set<string>() };
const FINANCE = { id: 3, position_name: 'Finance Manager', permissions_set: new Set<string>() };
const SALES_DIRECTOR = { id: 4, position_name: 'Sales Director', permissions_set: new Set<string>() };
const SALES_EXEC = { id: 5, position_name: 'Sales Executive', permissions_set: new Set<string>() };

// ── Fixture: one fair (project 1) with two confirmed SOs, one draft, one other fair ──
function fixture(): DataSet {
  return {
    mfg_sales_orders: [
      {
        doc_no: 'SO-1', status: 'CONFIRMED', project_id: 1, venue_id: 'v-1', customer_state: 'Selangor',
        salesperson_id: 'sp-1', branding: 'Brand A', so_date: '2026-07-05', ref: 'OF-1', venue: 'Hall 1',
        local_total_centi: 100000, balance_centi: 40000, deposit_centi: 10000, paid_centi: 10000,
        mattress_sofa_centi: 40000, bedframe_centi: 20000, accessories_centi: 5000, others_centi: 5000, service_centi: 30000,
        mattress_sofa_cost_centi: 20000, bedframe_cost_centi: 10000, accessories_cost_centi: 2000, others_cost_centi: 3000, service_cost_centi: 15000,
        total_cost_centi: 50000,
      },
      {
        doc_no: 'SO-2', status: 'CONFIRMED', project_id: 1, venue_id: 'v-2', customer_state: 'Johor',
        salesperson_id: 'sp-2', branding: 'Brand B', so_date: '2026-07-06', ref: 'OF-2', venue: 'Hall 2',
        local_total_centi: 50000, balance_centi: 0, deposit_centi: 0, paid_centi: 50000,
        mattress_sofa_centi: 50000, bedframe_centi: 0, accessories_centi: 0, others_centi: 0, service_centi: 0,
        mattress_sofa_cost_centi: 20000, bedframe_cost_centi: 0, accessories_cost_centi: 0, others_cost_centi: 0, service_cost_centi: 0,
        total_cost_centi: 20000,
      },
      { doc_no: 'SO-3', status: 'DRAFT', project_id: 1, so_date: '2026-07-07', total_cost_centi: 999 },
      { doc_no: 'SO-4', status: 'CONFIRMED', project_id: 2, venue_id: 'v-9', customer_state: 'Penang',
        salesperson_id: 'sp-1', branding: 'Brand A', so_date: '2026-07-05', ref: 'OF-9', venue: 'Other',
        local_total_centi: 12345, balance_centi: 0, deposit_centi: 0, paid_centi: 12345,
        mattress_sofa_centi: 12345, bedframe_centi: 0, accessories_centi: 0, others_centi: 0, service_centi: 0,
        mattress_sofa_cost_centi: 0, bedframe_cost_centi: 0, accessories_cost_centi: 0, others_cost_centi: 0, service_cost_centi: 0,
        total_cost_centi: 5000 },
    ],
    mfg_sales_order_payments: [
      { so_doc_no: 'SO-1', method: 'cash', amount_centi: 10000, merchant_provider: null, installment_months: null, is_deposit: true },
      { so_doc_no: 'SO-2', method: 'merchant', amount_centi: 50000, merchant_provider: 'Maybank', installment_months: null, is_deposit: false },
    ],
    delivery_orders: [
      { id: 'do-1', do_number: 'DO-1', so_doc_no: 'SO-1', do_date: '2026-07-08', delivered_at: '2026-07-08', status: 'DELIVERED' },
      { id: 'do-2', do_number: 'DO-2', so_doc_no: 'SO-2', do_date: '2026-07-09', delivered_at: null, status: 'LOADED' },
    ],
    delivery_order_items: [
      { delivery_order_id: 'do-1', qty: 2, unit_cost_centi: 30000, ship_cost_centi: 26000 }, // 52000
      { delivery_order_id: 'do-2', qty: 1, unit_cost_centi: 21000, ship_cost_centi: null },  // 21000, legacy
    ],
    sales_invoices: [
      { id: 'si-1', invoice_number: 'INV-1', so_doc_no: 'SO-1', delivery_order_id: 'do-1', invoice_date: '2026-07-10', total_centi: 100000, status: 'SENT' },
    ],
    sales_invoice_items: [
      { sales_invoice_id: 'si-1', qty: 2, unit_cost_centi: 27000, line_cost_centi: 54000 },
    ],
    mfg_sales_order_items: [
      { doc_no: 'SO-1', item_code: 'M1', description: 'Mattress', qty: 2, unit_price_centi: 35000, total_centi: 70000, unit_cost_centi: 25000, line_cost_centi: 50000, cancelled: false },
    ],
    staff: [
      { id: 'sp-1', name: 'Alice' },
      { id: 'sp-2', name: 'Bob' },
    ],
  };
}
const PROJECTS = [{ id: 1, name: 'KL Fair', start_date: '2026-07-01', end_date: '2026-07-10' }];

function appWith(data: DataSet, projects = PROJECTS) {
  const supabase = fakeSupabase(data);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, supabase as never);
    c.set('houzsUser' as never, state.houzsUser as never);
    await next();
  });
  app.get('/fair-report', fairReportHandler as never);
  app.get('/fair-report/:docNo', fairReportDetailHandler as never);
  return { app, env: { DB: fakeDB(projects) } as any };
}
function req(app: Hono, url: string, env: any) {
  return app.request(url, {}, env);
}

beforeEach(() => {
  state.houzsUser = OWNER; // default to management; individual tests override.
});

// ── (a) stage=so ─────────────────────────────────────────────────────────────
describe('stage=so', () => {
  test('returns one row per confirmed SO with amount/selling/service split, tender, category cost', async () => {
    const { app, env } = appWith(fixture());
    const res = await req(app, '/fair-report?stage=so', env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // SO-3 (draft) excluded; SO-4 (other fair) included only when unfiltered → 3 rows.
    const so1 = body.rows.find((r: any) => r.so_no === 'SO-1');
    expect(so1.amount_centi).toBe(100000);
    expect(so1.selling_centi).toBe(70000);       // product only
    expect(so1.service_rev_centi).toBe(30000);
    expect(so1.cost_by_category.service_cost_centi).toBe(15000);
    expect(so1.total_so_cost_centi).toBe(50000);
    expect(so1.margin_pct).toBeCloseTo(50);
    expect(so1.order_form).toBe('OF-1');
    expect(so1.salesperson).toBe('Alice');
    expect(so1.project).toBe('KL Fair');
    expect(so1.deposit_by_tender).toEqual({ Cash: 10000, Merchant: 0, Installment: 0, Online: 0 });
    expect(so1.payment_methods).toEqual(['Cash']);
    expect(so1.below_deposit).toBe(true);        // balance 40000, paid == deposit 10000
    // draft never appears
    expect(body.rows.some((r: any) => r.so_no === 'SO-3')).toBe(false);
    // summary present
    expect(body.summary.orders).toBe(body.rows.length);
  });
});

// ── (b) stage=do ─────────────────────────────────────────────────────────────
describe('stage=do', () => {
  test('one row per DO with SO-cost vs DO-cost + legacy flag; undelivered SOs still appear once a DO exists', async () => {
    const { app, env } = appWith(fixture());
    const res = await req(app, '/fair-report?stage=do', env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const do1 = body.rows.find((r: any) => r.do_no === 'DO-1');
    expect(do1.so_no).toBe('SO-1');
    expect(do1.total_so_cost_centi).toBe(50000);
    expect(do1.total_do_cost_centi).toBe(52000);   // 26000 ship × 2
    expect(do1.cost_delta_centi).toBe(2000);
    expect(do1.do_cost_is_legacy).toBe(false);
    const do2 = body.rows.find((r: any) => r.do_no === 'DO-2');
    expect(do2.total_do_cost_centi).toBe(21000);   // fell back to unit cost
    expect(do2.do_cost_is_legacy).toBe(true);
    expect(body.summary.deliveries).toBe(2);
  });
});

// ── (c) stage=invoice ────────────────────────────────────────────────────────
describe('stage=invoice', () => {
  test('one row per SI with so_cost · do_cost · landed(SI) cost progression + margin', async () => {
    const { app, env } = appWith(fixture());
    const res = await req(app, '/fair-report?stage=invoice', env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.rows).toHaveLength(1);
    const si = body.rows[0];
    expect(si.inv_no).toBe('INV-1');
    expect(si.so_no).toBe('SO-1');
    expect(si.so_cost_centi).toBe(50000);
    expect(si.do_cost_centi).toBe(52000);          // from linked do-1
    expect(si.si_cost_centi).toBe(54000);          // landed
    expect(si.invoiced_centi).toBe(100000);
    expect(si.margin_pct).toBeCloseTo(46);         // (100000-54000)/100000
  });
});

// ── (d) filters ──────────────────────────────────────────────────────────────
describe('filters narrow correctly', () => {
  test('project filter keeps only that fair', async () => {
    const { app, env } = appWith(fixture());
    const body = (await (await req(app, '/fair-report?stage=so&project=1', env)).json()) as any;
    expect(body.rows.map((r: any) => r.so_no).sort()).toEqual(['SO-1', 'SO-2']);
    expect(body.rows.some((r: any) => r.so_no === 'SO-4')).toBe(false);
  });
  test('salesperson filter', async () => {
    const { app, env } = appWith(fixture());
    const body = (await (await req(app, '/fair-report?stage=so&salesperson=sp-2', env)).json()) as any;
    expect(body.rows.map((r: any) => r.so_no)).toEqual(['SO-2']);
  });
  test('state filter', async () => {
    const { app, env } = appWith(fixture());
    const body = (await (await req(app, '/fair-report?stage=so&state=Johor', env)).json()) as any;
    expect(body.rows.map((r: any) => r.so_no)).toEqual(['SO-2']);
  });
  test('venue filter (on the venue TEXT, not the dead venue_id column)', async () => {
    const { app, env } = appWith(fixture());
    const body = (await (await req(app, '/fair-report?stage=so&venue=Hall%201', env)).json()) as any;
    expect(body.rows.map((r: any) => r.so_no)).toEqual(['SO-1']);
  });
  test('branding filter', async () => {
    const { app, env } = appWith(fixture());
    const body = (await (await req(app, '/fair-report?stage=so&branding=Brand%20B', env)).json()) as any;
    expect(body.rows.map((r: any) => r.so_no)).toEqual(['SO-2']);
  });
  test('month filter narrows by so_date', async () => {
    const { app, env } = appWith(fixture());
    const inJul = (await (await req(app, '/fair-report?stage=so&month=2026-07', env)).json()) as any;
    expect(inJul.rows.length).toBeGreaterThan(0);
    const inAug = (await (await req(app, '/fair-report?stage=so&month=2026-08', env)).json()) as any;
    expect(inAug.rows).toHaveLength(0);
  });
});

// ── (e) PERMISSION matrix over HTTP ──────────────────────────────────────────
describe('permission matrix (HTTP status)', () => {
  const stages = ['so', 'do', 'invoice'] as const;

  test('ordinary salesperson → 403 on every stage', async () => {
    state.houzsUser = SALES_EXEC;
    const { app, env } = appWith(fixture());
    for (const s of stages) {
      const res = await req(app, `/fair-report?stage=${s}`, env);
      expect(res.status).toBe(403);
    }
  });

  test('Sales Director → 200 on so, 403 on do + invoice', async () => {
    state.houzsUser = SALES_DIRECTOR;
    const { app, env } = appWith(fixture());
    expect((await req(app, '/fair-report?stage=so', env)).status).toBe(200);
    expect((await req(app, '/fair-report?stage=do', env)).status).toBe(403);
    expect((await req(app, '/fair-report?stage=invoice', env)).status).toBe(403);
  });

  test('management (owner / Super Admin / Finance) → 200 on all stages', async () => {
    for (const mgr of [OWNER, SUPER_ADMIN, FINANCE]) {
      state.houzsUser = mgr;
      const { app, env } = appWith(fixture());
      for (const s of stages) {
        expect((await req(app, `/fair-report?stage=${s}`, env)).status).toBe(200);
      }
    }
  });

  test('missing / bad stage → 400', async () => {
    state.houzsUser = OWNER;
    const { app, env } = appWith(fixture());
    expect((await req(app, '/fair-report', env)).status).toBe(400);
    expect((await req(app, '/fair-report?stage=nope', env)).status).toBe(400);
  });
});

// ── DETAIL ───────────────────────────────────────────────────────────────────
describe('per-order detail', () => {
  test('returns lines, cost-by-category, deposit-by-tender, and SO→DO→Invoice linkage', async () => {
    state.houzsUser = OWNER;
    const { app, env } = appWith(fixture());
    const res = await req(app, '/fair-report/SO-1', env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.so_no).toBe('SO-1');
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].item_code).toBe('M1');
    expect(body.lines[0].line_cost_centi).toBe(50000);
    expect(body.cost_by_category.mattress_sofa_cost_centi).toBe(20000);
    expect(body.deposit_by_tender).toEqual({ Cash: 10000, Merchant: 0, Installment: 0, Online: 0 });
    expect(body.linkage.do_nos).toEqual(['DO-1']);
    expect(body.linkage.invoice_nos).toEqual(['INV-1']);
  });

  test('ordinary salesperson is refused the detail (403)', async () => {
    state.houzsUser = SALES_EXEC;
    const { app, env } = appWith(fixture());
    expect((await req(app, '/fair-report/SO-1', env)).status).toBe(403);
  });

  test('unknown SO → 404', async () => {
    state.houzsUser = OWNER;
    const { app, env } = appWith(fixture());
    expect((await req(app, '/fair-report/NOPE', env)).status).toBe(404);
  });
});
