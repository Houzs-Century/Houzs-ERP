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
  /* `.not(col,'in','(A,B)')` — the report's scope predicate since 2026-08-31
     (draft/cancelled out, every other status in). PostgREST spells the list
     parenthesised, so parse it the same way the real client sends it. */
  not(col: string, op: string, list: string) {
    if (op !== 'in') throw new Error(`FakeQuery: unsupported .not(${op})`);
    const set = new Set(String(list).replace(/^\(|\)$/g, '').split(',').map((x) => x.trim().replace(/^"|"$/g, '')));
    this.preds.push((r) => !set.has(String(r[col] ?? '')));
    return this;
  }
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
        local_total_sen: 100000, balance_sen: 40000, deposit_sen: 10000, paid_sen: 10000,
        mattress_sofa_sen: 40000, bedframe_sen: 20000, accessories_sen: 5000, others_sen: 5000, service_sen: 30000,
        mattress_sofa_cost_sen: 20000, bedframe_cost_sen: 10000, accessories_cost_sen: 2000, others_cost_sen: 3000, service_cost_sen: 15000,
        total_cost_sen: 50000,
      },
      {
        doc_no: 'SO-2', status: 'CONFIRMED', project_id: 1, venue_id: 'v-2', customer_state: 'Johor',
        salesperson_id: 'sp-2', branding: 'Brand B', so_date: '2026-07-06', ref: 'OF-2', venue: 'Hall 2',
        local_total_sen: 50000, balance_sen: 0, deposit_sen: 0, paid_sen: 50000,
        mattress_sofa_sen: 50000, bedframe_sen: 0, accessories_sen: 0, others_sen: 0, service_sen: 0,
        mattress_sofa_cost_sen: 20000, bedframe_cost_sen: 0, accessories_cost_sen: 0, others_cost_sen: 0, service_cost_sen: 0,
        total_cost_sen: 20000,
      },
      { doc_no: 'SO-3', status: 'DRAFT', project_id: 1, so_date: '2026-07-07', total_cost_sen: 999 },
      /* 2026-08-31 (owner: "很多单都没进得来…可能因为我还没 delivered"): a fair's
         orders KEEP moving after confirmation, and the report used to anchor on
         status='CONFIRMED' alone — so an order dropped off the report the moment
         it was delivered (measured on 2990: 34 of 49 DOs were invisible for
         exactly this reason). Delivered/invoiced/closed orders are the fair's
         completed business and belong in it; only DRAFT and CANCELLED are out. */
      { doc_no: 'SO-5', status: 'DELIVERED', project_id: 1, venue_id: 'v-1', customer_state: 'Selangor',
        salesperson_id: 'sp-1', branding: 'Brand A', so_date: '2026-07-08', ref: 'OF-5', venue: 'Hall 1',
        local_total_sen: 20000, balance_sen: 0, deposit_sen: 0, paid_sen: 20000,
        mattress_sofa_sen: 20000, bedframe_sen: 0, accessories_sen: 0, others_sen: 0, service_sen: 0,
        mattress_sofa_cost_sen: 8000, bedframe_cost_sen: 0, accessories_cost_sen: 0, others_cost_sen: 0, service_cost_sen: 0,
        total_cost_sen: 8000 },
      { doc_no: 'SO-6', status: 'CANCELLED', project_id: 1, so_date: '2026-07-09', total_cost_sen: 777 },
      { doc_no: 'SO-4', status: 'CONFIRMED', project_id: 2, venue_id: 'v-9', customer_state: 'Penang',
        salesperson_id: 'sp-1', branding: 'Brand A', so_date: '2026-07-05', ref: 'OF-9', venue: 'Other',
        local_total_sen: 12345, balance_sen: 0, deposit_sen: 0, paid_sen: 12345,
        mattress_sofa_sen: 12345, bedframe_sen: 0, accessories_sen: 0, others_sen: 0, service_sen: 0,
        mattress_sofa_cost_sen: 0, bedframe_cost_sen: 0, accessories_cost_sen: 0, others_cost_sen: 0, service_cost_sen: 0,
        total_cost_sen: 5000 },
    ],
    mfg_sales_order_payments: [
      { so_doc_no: 'SO-1', method: 'cash', amount_sen: 10000, merchant_provider: null, installment_months: null, is_deposit: true },
      { so_doc_no: 'SO-2', method: 'merchant', amount_sen: 50000, merchant_provider: 'Maybank', installment_months: null, is_deposit: false },
    ],
    delivery_orders: [
      { id: 'do-1', do_number: 'DO-1', so_doc_no: 'SO-1', do_date: '2026-07-08', delivered_at: '2026-07-08', status: 'DELIVERED' },
      { id: 'do-2', do_number: 'DO-2', so_doc_no: 'SO-2', do_date: '2026-07-09', delivered_at: null, status: 'LOADED' },
    ],
    delivery_order_items: [
      { delivery_order_id: 'do-1', qty: 2, unit_cost_sen: 30000, ship_cost_sen: 26000 }, // 52000
      { delivery_order_id: 'do-2', qty: 1, unit_cost_sen: 21000, ship_cost_sen: null },  // 21000, legacy
    ],
    sales_invoices: [
      { id: 'si-1', invoice_number: 'INV-1', so_doc_no: 'SO-1', delivery_order_id: 'do-1', invoice_date: '2026-07-10', total_sen: 100000, status: 'SENT' },
    ],
    sales_invoice_items: [
      { sales_invoice_id: 'si-1', qty: 2, unit_cost_sen: 27000, line_cost_sen: 54000 },
    ],
    mfg_sales_order_items: [
      { doc_no: 'SO-1', item_code: 'M1', description: 'Mattress', qty: 2, unit_price_sen: 35000, total_sen: 70000, unit_cost_sen: 25000, line_cost_sen: 50000, cancelled: false },
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
    expect(so1.amount_sen).toBe(100000);
    expect(so1.selling_sen).toBe(70000);       // product only
    expect(so1.service_rev_sen).toBe(30000);
    expect(so1.cost_by_category.service_cost_sen).toBe(15000);
    expect(so1.total_so_cost_sen).toBe(50000);
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
    expect(do1.total_so_cost_sen).toBe(50000);
    expect(do1.total_do_cost_sen).toBe(52000);   // 26000 ship × 2
    expect(do1.cost_delta_sen).toBe(2000);
    expect(do1.do_cost_is_legacy).toBe(false);
    const do2 = body.rows.find((r: any) => r.do_no === 'DO-2');
    expect(do2.total_do_cost_sen).toBe(21000);   // fell back to unit cost
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
    expect(si.so_cost_sen).toBe(50000);
    expect(si.do_cost_sen).toBe(52000);          // from linked do-1
    expect(si.si_cost_sen).toBe(54000);          // landed
    expect(si.invoiced_sen).toBe(100000);
    expect(si.margin_pct).toBeCloseTo(46);         // (100000-54000)/100000
  });
});

// ── (d) filters ──────────────────────────────────────────────────────────────
describe('filters narrow correctly', () => {
  test('project filter keeps only that fair', async () => {
    const { app, env } = appWith(fixture());
    const body = (await (await req(app, '/fair-report?stage=so&project=1', env)).json()) as any;
    /* SO-5 is DELIVERED and belongs to this fair — in scope since 2026-08-31
       (see the fixture note); SO-3 DRAFT and SO-6 CANCELLED stay out. */
    expect(body.rows.map((r: any) => r.so_no).sort()).toEqual(['SO-1', 'SO-2', 'SO-5']);
    expect(body.rows.some((r: any) => r.so_no === 'SO-4')).toBe(false);
    expect(body.rows.some((r: any) => r.so_no === 'SO-3' || r.so_no === 'SO-6')).toBe(false);
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
    // SO-5 (delivered, Hall 1) is in scope too — completed business stays on the fair.
    expect(body.rows.map((r: any) => r.so_no).sort()).toEqual(['SO-1', 'SO-5']);
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
    expect(body.lines[0].line_cost_sen).toBe(50000);
    expect(body.cost_by_category.mattress_sofa_cost_sen).toBe(20000);
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

// ── Balance comes from the LEDGER, never from mfg_sales_orders.balance_sen ────
//
// `recomputeTotals` writes `balance_sen = local_total_sen = total_revenue_sen =
// grandTotal` on every edit, so the column is the ORDER VALUE, not what is
// still owed — the reasoning is set out in scm/shared/so-outstanding.ts. The
// Fair Report read it straight off the header while computing `paid_total_sen`
// from the live ledger on the SAME row, so the two cells contradicted each
// other and the Balance KPI counted collected money as outstanding.
//
// Measured on production 2026-08-21 (backend/scripts/check-report-money.mjs,
// run 32466500870): 85 of 103 live orders, RM 238,652.50 overstated, of which
// RM 132,869.50 sat on the 51 CONFIRMED orders that are this report's row set.
describe('balance is ledger-derived, not the stale header column', () => {
  /* One fair, one confirmed order, shaped exactly like production: the header
     says the whole RM 1,000.00 is still owed, the ledger holds RM 400.00. */
  const ledgerData = (): DataSet => ({
    mfg_sales_orders: [
      {
        doc_no: 'SO-BAL', status: 'CONFIRMED', project_id: 1, venue_id: 'v-1', customer_state: 'Selangor',
        salesperson_id: 'sp-1', branding: 'Brand A', so_date: '2026-07-05', ref: 'OF-BAL', venue: 'Hall 1',
        local_total_sen: 100000, total_revenue_sen: 100000,
        // What recomputeTotals actually leaves behind: balance == the total.
        balance_sen: 100000, deposit_sen: 15000, paid_sen: 0,
        mattress_sofa_sen: 100000, bedframe_sen: 0, accessories_sen: 0, others_sen: 0, service_sen: 0,
        mattress_sofa_cost_sen: 60000, bedframe_cost_sen: 0, accessories_cost_sen: 0,
        others_cost_sen: 0, service_cost_sen: 0, total_cost_sen: 60000,
      },
    ],
    mfg_sales_order_payments: [
      { so_doc_no: 'SO-BAL', method: 'cash', amount_sen: 15000, merchant_provider: null, installment_months: null, is_deposit: true },
      { so_doc_no: 'SO-BAL', method: 'transfer', amount_sen: 25000, merchant_provider: null, installment_months: null, is_deposit: false },
    ],
    mfg_sales_order_items: [
      { doc_no: 'SO-BAL', item_code: 'M1', description: 'Mattress', qty: 1, unit_price_sen: 100000, total_sen: 100000, unit_cost_sen: 60000, line_cost_sen: 60000, cancelled: false },
    ],
    staff: [{ id: 'sp-1', name: 'Alice' }],
  });

  test('stage=so: the row and the summary report amount minus the ledger', async () => {
    state.houzsUser = OWNER;
    const { app, env } = appWith(ledgerData());
    const body = (await (await req(app, '/fair-report?stage=so', env)).json()) as any;
    const row = body.rows.find((r: any) => r.so_no === 'SO-BAL');
    expect(row.amount_sen).toBe(100000);
    expect(row.paid_total_sen).toBe(40000);        // 15000 deposit + 25000, ledger only
    expect(row.balance_sen).toBe(60000);           // NOT the header's 100000
    expect(body.summary.total_balance_sen).toBe(60000);
  });

  test('the deposit is not double counted when the ledger already carries it', async () => {
    state.houzsUser = OWNER;
    const { app, env } = appWith(ledgerData());
    const body = (await (await req(app, '/fair-report?stage=so', env)).json()) as any;
    const row = body.rows.find((r: any) => r.so_no === 'SO-BAL');
    // header deposit_sen is 15000 and the ledger's is_deposit row is the same
    // money — soPaidSen must count it ONCE.
    expect(row.paid_total_sen).toBe(40000);
    expect(row.deposit_sen).toBe(15000);
  });

  test('a LEGACY deposit that never reached the ledger is still counted', async () => {
    state.houzsUser = OWNER;
    const data = ledgerData();
    // Strip the is_deposit ledger row: this is the pre-drawer shape where the
    // deposit lives only on the header.
    data.mfg_sales_order_payments = data.mfg_sales_order_payments.filter((p) => !p.is_deposit);
    const { app, env } = appWith(data);
    const body = (await (await req(app, '/fair-report?stage=so', env)).json()) as any;
    const row = body.rows.find((r: any) => r.so_no === 'SO-BAL');
    expect(row.paid_total_sen).toBe(40000);        // 15000 header deposit + 25000 ledger
    expect(row.balance_sen).toBe(60000);
  });

  test('below_deposit is decided on the ledger balance, not the header one', async () => {
    state.houzsUser = OWNER;
    const data = ledgerData();
    // Settle the order in full: nothing is owed, so it is not "below deposit"
    // — the header column would still say 100000 owing and force `true`.
    data.mfg_sales_order_payments = [
      { so_doc_no: 'SO-BAL', method: 'cash', amount_sen: 15000, merchant_provider: null, installment_months: null, is_deposit: true },
      { so_doc_no: 'SO-BAL', method: 'transfer', amount_sen: 85000, merchant_provider: null, installment_months: null, is_deposit: false },
    ];
    const { app, env } = appWith(data);
    const body = (await (await req(app, '/fair-report?stage=so', env)).json()) as any;
    const row = body.rows.find((r: any) => r.so_no === 'SO-BAL');
    expect(row.balance_sen).toBe(0);
    expect(row.below_deposit).toBe(false);
  });

  test('per-order detail agrees with the list row', async () => {
    state.houzsUser = OWNER;
    const { app, env } = appWith(ledgerData());
    const body = (await (await req(app, '/fair-report/SO-BAL', env)).json()) as any;
    expect(body.paid_total_sen).toBe(40000);
    expect(body.balance_sen).toBe(60000);
  });
});
