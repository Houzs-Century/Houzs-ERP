import { Hono } from 'hono';
import { beforeEach, describe, expect, test } from 'vitest';
import { fairReportHandler } from '../src/scm/routes/reports';
import {
  computeFairOverheads,
  everyFairPnl,
  fairPnlLineCost,
  summarizeFairPnl,
  emptyOverheads,
  type FairCostRate,
  type FairPnlSummaryRow,
} from '../src/scm/lib/fair-report';

/* stage=pnl driven END-TO-END through a bare Hono app that injects a fake scm
   supabase client + the Houzs caller + the ACTIVE COMPANY + a c.env.DB stub for
   the public projects / project_cost_rates lookups. Mirrors fairReport.route
   .test.ts, and additionally sets companyId so scopeToCompany actually filters —
   the point of the both-directions company-scope test below. */

const state = {
  houzsUser: undefined as any,
  companyId: undefined as number | undefined,
};

// ── Fake PostgREST query builder (same shape as fairReport.route.test.ts) ─────
class FakeQuery {
  private preds: Array<(r: any) => boolean> = [];
  private _range: [number, number] | null = null;
  constructor(private rows: any[]) {}
  select() { return this; }
  order() { return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  in(col: string, vals: unknown[]) { const s = new Set(vals.map(String)); this.preds.push((r) => s.has(String(r[col]))); return this; }
  /* `.not(col,'in','(A,B)')` — the report's scope predicate since 2026-08-31
     (draft/cancelled out, every other status in). Same shape the real client
     sends; the fairReport suite's fake carries the twin. */
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
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.apply(), error: null }).then(res, rej);
  }
}
type DataSet = Record<string, any[]>;
function fakeSupabase(data: DataSet) {
  return { from: (table: string) => new FakeQuery(data[table] ?? []) };
}

// ── Fake c.env.DB — public projects + project_cost_rates ─────────────────────
function fakeDB(projects: any[], rates: Record<string, FairCostRate>) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
            all: async () => {
              /* The every-fair read asks for many cards at once. */
              if (/FROM project_cost_rates WHERE brand IN/.test(sql)) {
                return { results: args.filter((b) => rates[String(b)]).map((b) => ({ brand: String(b), ...rates[String(b)] })) };
              }
              const ids = new Set(args.map(String));
              return { results: projects.filter((p) => ids.has(String(p.id))) };
            },
            first: async () => {
              if (/brand FROM projects WHERE id = \?/.test(sql)) {
                const p = projects.find((pp) => String(pp.id) === String(args[0]));
                return p ? { brand: p.brand ?? null } : null;
              }
              if (/FROM project_cost_rates WHERE brand = \?/.test(sql)) {
                return rates[String(args[0])] ?? null;
              }
              const ids = new Set(args.map(String));
              return projects.filter((p) => ids.has(String(p.id)))[0] ?? null;
            },
          };
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

const BRAND_A_RATE: FairCostRate = {
  transport_pct: 5,
  merchandise_pct: 2,
  commission_normal_pct: 10,
  commission_boost_pct: 15,
  boost_min_gp_pct: 40,
  boost_min_sales: 1000, // RINGGIT threshold, not centi
};

/* Fair = project 1 (Brand A). Company 1 has two confirmed SOs; company 2 has ONE
   confirmed SO on the SAME fair. A company-1 read must see only the first two and
   a company-2 read only the third — that asymmetry is the scope proof. */
function fixture(): DataSet {
  return {
    mfg_sales_orders: [
      { doc_no: 'SO-1', company_id: 1, status: 'CONFIRMED', project_id: 1, venue_id: 'v-1', customer_state: 'Selangor',
        salesperson_id: 'sp-1', branding: 'Brand A', so_date: '2026-07-05', ref: 'OF-1', venue: 'Hall 1',
        local_total_sen: 100000, balance_sen: 40000, deposit_sen: 10000, paid_sen: 10000,
        mattress_sofa_sen: 40000, bedframe_sen: 20000, accessories_sen: 5000, others_sen: 5000, service_sen: 30000,
        mattress_sofa_cost_sen: 20000, bedframe_cost_sen: 10000, accessories_cost_sen: 2000, others_cost_sen: 3000, service_cost_sen: 15000,
        total_cost_sen: 50000 },
      { doc_no: 'SO-2', company_id: 1, status: 'CONFIRMED', project_id: 1, venue_id: 'v-2', customer_state: 'Johor',
        salesperson_id: 'sp-2', branding: 'Brand A', so_date: '2026-07-06', ref: 'OF-2', venue: 'Hall 2',
        local_total_sen: 50000, balance_sen: 0, deposit_sen: 0, paid_sen: 50000,
        mattress_sofa_sen: 50000, bedframe_sen: 0, accessories_sen: 0, others_sen: 0, service_sen: 0,
        mattress_sofa_cost_sen: 20000, bedframe_cost_sen: 0, accessories_cost_sen: 0, others_cost_sen: 0, service_cost_sen: 0,
        total_cost_sen: 20000 },
      { doc_no: 'SO-3', company_id: 1, status: 'DRAFT', project_id: 1, so_date: '2026-07-07', total_cost_sen: 999 },
      { doc_no: 'SO-C2', company_id: 2, status: 'CONFIRMED', project_id: 1, venue_id: 'v-9', customer_state: 'Penang',
        salesperson_id: 'sp-1', branding: 'Brand A', so_date: '2026-07-05', ref: 'OF-9', venue: 'Booth',
        local_total_sen: 99999, balance_sen: 0, deposit_sen: 0, paid_sen: 99999,
        mattress_sofa_sen: 99999, bedframe_sen: 0, accessories_sen: 0, others_sen: 0, service_sen: 0,
        mattress_sofa_cost_sen: 0, bedframe_cost_sen: 0, accessories_cost_sen: 0, others_cost_sen: 0, service_cost_sen: 0,
        total_cost_sen: 11111 },
    ],
    delivery_orders: [
      { id: 'do-1', company_id: 1, do_number: 'DO-1', so_doc_no: 'SO-1', do_date: '2026-07-08', delivered_at: '2026-07-08', status: 'DELIVERED' },
      { id: 'do-2', company_id: 1, do_number: 'DO-2', so_doc_no: 'SO-2', do_date: '2026-07-09', delivered_at: null, status: 'LOADED' },
    ],
    delivery_order_items: [
      { delivery_order_id: 'do-1', company_id: 1, qty: 2, unit_cost_sen: 30000, ship_cost_sen: 26000 }, // 52000
      { delivery_order_id: 'do-2', company_id: 1, qty: 1, unit_cost_sen: 21000, ship_cost_sen: null },  // 21000, legacy fallback
    ],
    sales_invoices: [
      { id: 'si-1', company_id: 1, invoice_number: 'INV-1', so_doc_no: 'SO-1', delivery_order_id: 'do-1', invoice_date: '2026-07-10', total_sen: 100000, status: 'SENT' },
    ],
    sales_invoice_items: [
      { sales_invoice_id: 'si-1', company_id: 1, qty: 2, unit_cost_sen: 27000, line_cost_sen: 54000 }, // landed 54000
    ],
    staff: [
      { id: 'sp-1', name: 'Alice' },
      { id: 'sp-2', name: 'Bob' },
    ],
  };
}
const PROJECTS = [
  { id: 1, name: 'KL Fair', start_date: '2026-07-01', end_date: '2026-07-10', brand: 'Brand A' },
  { id: 2, name: 'Unbranded Fair', start_date: '2026-07-01', end_date: '2026-07-10', brand: null },
];
const RATES: Record<string, FairCostRate> = { 'Brand A': BRAND_A_RATE };

function appWith(data: DataSet, opts?: { projects?: any[]; rates?: Record<string, FairCostRate> }) {
  const supabase = fakeSupabase(data);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, supabase as never);
    c.set('houzsUser' as never, state.houzsUser as never);
    if (state.companyId != null) c.set('companyId' as never, state.companyId as never);
    await next();
  });
  app.get('/fair-report', fairReportHandler as never);
  return { app, env: { DB: fakeDB(opts?.projects ?? PROJECTS, opts?.rates ?? RATES) } as any };
}
function req(app: Hono, url: string, env: any) {
  return app.request(url, {}, env);
}

beforeEach(() => {
  state.houzsUser = OWNER;
  state.companyId = undefined;
});

// ── Company scope — BOTH directions ──────────────────────────────────────────
describe('stage=pnl company scope (both directions)', () => {
  test('company 1 sees only its two orders; the 2990 order on the same fair is excluded', async () => {
    state.companyId = 1;
    const { app, env } = appWith(fixture());
    const res = await req(app, '/fair-report?stage=pnl&project=1', env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.rows.map((r: any) => r.so_no).sort()).toEqual(['SO-1', 'SO-2']);
    expect(body.rows.some((r: any) => r.so_no === 'SO-C2')).toBe(false);
    expect(body.summary.orders).toBe(2);
    expect(body.summary.total_revenue_sen).toBe(150000);
  });

  test('company 2 sees only ITS order on the same fair — the reverse proves scoping is real', async () => {
    state.companyId = 2;
    const { app, env } = appWith(fixture());
    const body = (await (await req(app, '/fair-report?stage=pnl&project=1', env)).json()) as any;
    expect(body.rows.map((r: any) => r.so_no)).toEqual(['SO-C2']);
    expect(body.rows.some((r: any) => r.so_no === 'SO-1')).toBe(false);
    expect(body.summary.total_revenue_sen).toBe(99999);
  });
});

// ── The P&L numbers, end-to-end ──────────────────────────────────────────────
describe('stage=pnl math end-to-end', () => {
  test('company 1: three-way COGS (most-progressed), gross, boost overhead, net', async () => {
    state.companyId = 1;
    const { app, env } = appWith(fixture());
    const body = (await (await req(app, '/fair-report?stage=pnl&project=1', env)).json()) as any;

    const so1 = body.rows.find((r: any) => r.so_no === 'SO-1');
    expect(so1.revenue_sen).toBe(100000);
    expect(so1.so_cost_sen).toBe(50000);
    expect(so1.do_cost_sen).toBe(52000);
    expect(so1.si_cost_sen).toBe(54000);
    expect(so1.effective_cost_sen).toBe(54000);      // invoiced -> landed wins
    expect(so1.effective_cost_stage).toBe('invoice');
    expect(so1.gross_profit_sen).toBe(46000);

    const so2 = body.rows.find((r: any) => r.so_no === 'SO-2');
    expect(so2.do_cost_sen).toBe(21000);
    expect(so2.si_cost_sen).toBeNull();              // no SI -> null, not 0
    expect(so2.effective_cost_sen).toBe(21000);      // delivered -> DO cost wins
    expect(so2.effective_cost_stage).toBe('do');

    const s = body.summary;
    expect(s.total_revenue_sen).toBe(150000);
    expect(s.total_product_rev_sen).toBe(120000);
    expect(s.total_service_rev_sen).toBe(30000);
    expect(s.total_cogs_sen).toBe(75000);            // 54000 + 21000
    expect(s.gross_profit_sen).toBe(75000);
    expect(s.gross_margin_pct).toBeCloseTo(50);
    // Brand A boost tier: GP 50% >= 40 and RM1500 >= RM1000 -> commission 15%.
    expect(s.overheads.commission_is_boost).toBe(true);
    expect(s.overheads.commission_pct).toBe(15);
    expect(s.overheads.transport_sen).toBe(7500);    // 5% of 150000
    expect(s.overheads.merchandise_sen).toBe(3000);  // 2%
    expect(s.overheads.commission_sen).toBe(22500);  // 15%
    expect(s.overheads.total_overhead_sen).toBe(33000);
    expect(s.net_profit_sen).toBe(42000);            // 75000 - 33000
    expect(s.net_margin_pct).toBeCloseTo(28);
    expect(body.meta.brand).toBe('Brand A');
    expect(body.meta.rate_present).toBe(true);
  });

  test('company 2: revenue RM999.99 just misses the RM1000 sales gate -> NORMAL commission (units are ringgit, not centi)', async () => {
    state.companyId = 2;
    const { app, env } = appWith(fixture());
    const body = (await (await req(app, '/fair-report?stage=pnl&project=1', env)).json()) as any;
    const s = body.summary;
    expect(s.total_revenue_sen).toBe(99999);
    expect(s.overheads.commission_is_boost).toBe(false);
    expect(s.overheads.commission_pct).toBe(10);       // normal, boost gate missed by 1 sen
    expect(s.overheads.commission_sen).toBe(10000);  // round(99999 * 10 / 100)
    expect(s.overheads.total_overhead_sen).toBe(17000); // 5000 + 2000 + 10000
    expect(s.net_profit_sen).toBe(71888);            // (99999 - 11111) - 17000
  });
});

// ── needs_project + rate-absent ──────────────────────────────────────────────
describe('stage=pnl guards', () => {
  test('no project selected -> 200 with needs_project, no rows', async () => {
    state.companyId = 1;
    const { app, env } = appWith(fixture());
    const res = await req(app, '/fair-report?stage=pnl', env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.meta.needs_project).toBe(true);
    expect(body.rows).toHaveLength(0);
    expect(body.summary.net_profit_sen).toBe(0);
  });

  test('a fair whose brand has no rate card -> zero overhead, net == gross', async () => {
    state.companyId = 1;
    // Move both orders onto project 2 (brand null, no rate).
    const data = fixture();
    for (const so of data.mfg_sales_orders) so.project_id = 2;
    const { app, env } = appWith(data);
    const body = (await (await req(app, '/fair-report?stage=pnl&project=2', env)).json()) as any;
    expect(body.meta.rate_present).toBe(false);
    expect(body.summary.overheads.total_overhead_sen).toBe(0);
    expect(body.summary.net_profit_sen).toBe(body.summary.gross_profit_sen);
  });
});

// ── Every fair (no fair picked; owner 2026/11/02) ────────────────────────────
/* A second fair on Brand B, with its own (normal-only) card, and an order with
   no fair at all — the period then holds two fairs and one order aside. */
const BRAND_B_RATE: FairCostRate = {
  transport_pct: 3, merchandise_pct: 1, commission_normal_pct: 8,
  commission_boost_pct: null, boost_min_gp_pct: null, boost_min_sales: null,
};
function twoFairs(): DataSet {
  const data = fixture();
  data.mfg_sales_orders.push(
    { doc_no: 'SO-B1', company_id: 1, status: 'CONFIRMED', project_id: 3, venue_id: null, customer_state: 'Penang',
      salesperson_id: 'sp-1', branding: 'Brand B', so_date: '2026-07-20', ref: 'OF-B1', venue: 'Spice Arena',
      local_total_sen: 200000, balance_sen: 0, deposit_sen: 0, paid_sen: 200000,
      mattress_sofa_sen: 200000, bedframe_sen: 0, accessories_sen: 0, others_sen: 0, service_sen: 0,
      mattress_sofa_cost_sen: 120000, bedframe_cost_sen: 0, accessories_cost_sen: 0, others_cost_sen: 0, service_cost_sen: 0,
      total_cost_sen: 120000 },
    { doc_no: 'SO-N1', company_id: 1, status: 'CONFIRMED', project_id: null, venue_id: null, customer_state: 'Selangor',
      salesperson_id: 'sp-2', branding: 'Brand A', so_date: '2026-07-21', ref: 'OF-N1', venue: 'Showroom',
      local_total_sen: 30000, balance_sen: 0, deposit_sen: 0, paid_sen: 30000,
      mattress_sofa_sen: 30000, bedframe_sen: 0, accessories_sen: 0, others_sen: 0, service_sen: 0,
      mattress_sofa_cost_sen: 10000, bedframe_cost_sen: 0, accessories_cost_sen: 0, others_cost_sen: 0, service_cost_sen: 0,
      total_cost_sen: 10000 },
  );
  return data;
}
const TWO_FAIR_PROJECTS = [
  ...PROJECTS,
  { id: 3, name: 'Penang Fair', start_date: '2026-07-18', end_date: '2026-07-27', brand: '  Brand B ' },
];
const TWO_FAIR_RATES: Record<string, FairCostRate> = { ...RATES, 'Brand B': BRAND_B_RATE };

describe('stage=pnl with no fair picked — every fair (c7)', () => {
  test('a line per fair with orders in the period, newest first, each on its own card; the order with no fair aside', async () => {
    state.companyId = 1;
    const { app, env } = appWith(twoFairs(), { projects: TWO_FAIR_PROJECTS, rates: TWO_FAIR_RATES });
    const res = await req(app, '/fair-report?stage=pnl&date_from=2026-07-01&date_to=2026-07-31', env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    /* The per-order shape is unchanged: no rows until a fair is picked. */
    expect(body.rows).toHaveLength(0);
    expect(body.meta.needs_project).toBe(true);
    expect(body.fairs.map((f: any) => f.project)).toEqual(['Penang Fair', 'KL Fair']);

    const kl = body.fairs.find((f: any) => f.project_id === 1);
    expect(kl.project_start_date).toBe('2026-07-01');
    expect(kl.brand).toBe('Brand A');
    expect(kl.rate_present).toBe(true);
    expect(kl.summary.orders).toBe(2);
    expect(kl.summary.total_cogs_sen).toBe(75000);           // SO-1 landed 54000 + SO-2 DO 21000
    expect(kl.summary.overheads.commission_is_boost).toBe(true);
    expect(kl.summary.net_profit_sen).toBe(42000);

    const pg = body.fairs.find((f: any) => f.project_id === 3);
    expect(pg.brand).toBe('Brand B');                          // trimmed, as one fair's lookup
    expect(pg.venue).toBe('Spice Arena');
    expect(pg.summary.total_revenue_sen).toBe(200000);
    expect(pg.summary.total_cogs_sen).toBe(120000);            // no DO, no SI: the SO cost
    expect(pg.summary.overheads.commission_pct).toBe(8);       // Brand B has no boost
    expect(pg.summary.overheads.total_overhead_sen).toBe(24000); // 3% + 1% + 8% of 200000
    expect(pg.summary.net_profit_sen).toBe(56000);

    expect(body.no_fair).toEqual({ orders: 1, revenue_sen: 30000 });
  });

  test('a fair\'s line carries exactly the figures its own P&L shows once picked', async () => {
    state.companyId = 1;
    const { app, env } = appWith(twoFairs(), { projects: TWO_FAIR_PROJECTS, rates: TWO_FAIR_RATES });
    const every = (await (await req(app, '/fair-report?stage=pnl&date_from=2026-07-01&date_to=2026-07-31', env)).json()) as any;
    for (const id of [1, 3]) {
      const picked = (await (await req(app, `/fair-report?stage=pnl&project=${id}&date_from=2026-07-01&date_to=2026-07-31`, env)).json()) as any;
      expect(every.fairs.find((f: any) => f.project_id === id).summary).toEqual(picked.summary);
    }
  });

  test('the dates pick the orders: a fair with none in them has no line', async () => {
    state.companyId = 1;
    const { app, env } = appWith(twoFairs(), { projects: TWO_FAIR_PROJECTS, rates: TWO_FAIR_RATES });
    const body = (await (await req(app, '/fair-report?stage=pnl&date_from=2026-07-15&date_to=2026-07-31', env)).json()) as any;
    expect(body.fairs.map((f: any) => f.project_id)).toEqual([3]);
    expect(body.no_fair.orders).toBe(1);
  });

  test('a fair whose brand has no card shows its line with zero overhead', async () => {
    state.companyId = 1;
    const { app, env } = appWith(twoFairs(), { projects: TWO_FAIR_PROJECTS, rates: RATES });
    const body = (await (await req(app, '/fair-report?stage=pnl&date_from=2026-07-01&date_to=2026-07-31', env)).json()) as any;
    const pg = body.fairs.find((f: any) => f.project_id === 3);
    expect(pg.rate_present).toBe(false);
    expect(pg.summary.overheads.total_overhead_sen).toBe(0);
    expect(pg.summary.net_profit_sen).toBe(pg.summary.gross_profit_sen);
  });

  test('the same gate: a Sales Director and a salesperson are refused the every-fair read', async () => {
    state.companyId = 1;
    for (const who of [SALES_DIRECTOR, SALES_EXEC]) {
      state.houzsUser = who;
      const { app, env } = appWith(twoFairs(), { projects: TWO_FAIR_PROJECTS, rates: TWO_FAIR_RATES });
      expect((await req(app, '/fair-report?stage=pnl&date_from=2026-07-01&date_to=2026-07-31', env)).status).toBe(403);
    }
  });

  test('company scope holds: the other company\'s orders on the same fair are not in its line', async () => {
    state.companyId = 2;
    const { app, env } = appWith(twoFairs(), { projects: TWO_FAIR_PROJECTS, rates: TWO_FAIR_RATES });
    const body = (await (await req(app, '/fair-report?stage=pnl&date_from=2026-07-01&date_to=2026-07-31', env)).json()) as any;
    expect(body.fairs).toHaveLength(1);
    expect(body.fairs[0].summary.total_revenue_sen).toBe(99999);
    expect(body.no_fair.orders).toBe(0);
  });
});

describe('stage=pnl with a fair picked — the card and the fair in meta', () => {
  test('meta names the card the overhead is priced on, and the fair itself', async () => {
    state.companyId = 1;
    const { app, env } = appWith(fixture());
    const body = (await (await req(app, '/fair-report?stage=pnl&project=1', env)).json()) as any;
    expect(body.meta.rate).toEqual(BRAND_A_RATE);
    expect(body.meta.fair).toEqual({ project_id: 1, project: 'KL Fair', project_start_date: '2026-07-01', project_end_date: '2026-07-10' });
  });

  test('a fair with no order in the dates is still named, with its own dates', async () => {
    state.companyId = 1;
    const { app, env } = appWith(fixture());
    const body = (await (await req(app, '/fair-report?stage=pnl&project=1&date_from=2026-08-01&date_to=2026-08-31', env)).json()) as any;
    expect(body.rows).toHaveLength(0);
    expect(body.meta.fair).toEqual({ project_id: 1, project: 'KL Fair', project_start_date: '2026-07-01', project_end_date: '2026-07-10' });
  });
});

describe('everyFairPnl (pure)', () => {
  const line = (amount: number, cost: number) => ({
    amount_sen: amount, selling_sen: amount, service_rev_sen: 0, so_cost_sen: cost, do_cost_sen: null, si_cost_sen: null, effective_cost_sen: cost,
  });
  test('groups by fair, names the commonest venue, keeps the fair-less orders aside', () => {
    const out = everyFairPnl([
      { ...line(1000, 400), project_id: 7, venue: 'Hall B' },
      { ...line(2000, 900), project_id: 7, venue: 'Hall A' },
      { ...line(500, 100), project_id: 7, venue: 'Hall A' },
      { ...line(800, 300), project_id: null, venue: 'Showroom' },
    ], () => ({ name: 'Fair 7', start_date: '2026-07-01', end_date: '2026-07-05', brand: null, rate: null }));
    expect(out.fairs).toHaveLength(1);
    expect(out.fairs[0]!.venue).toBe('Hall A');
    expect(out.fairs[0]!.summary.total_revenue_sen).toBe(3500);
    expect(out.fairs[0]!.summary.net_profit_sen).toBe(2100);
    expect(out.no_fair).toEqual({ orders: 1, revenue_sen: 800 });
  });
});

// ── Permission matrix ────────────────────────────────────────────────────────
describe('stage=pnl permission matrix', () => {
  test('ordinary salesperson -> 403', async () => {
    state.houzsUser = SALES_EXEC; state.companyId = 1;
    const { app, env } = appWith(fixture());
    expect((await req(app, '/fair-report?stage=pnl&project=1', env)).status).toBe(403);
  });

  test('Sales Director -> 403 (P&L is management-only, unlike stage=so)', async () => {
    state.houzsUser = SALES_DIRECTOR; state.companyId = 1;
    const { app, env } = appWith(fixture());
    expect((await req(app, '/fair-report?stage=pnl&project=1', env)).status).toBe(403);
  });

  test('management (owner / Super Admin / Finance) -> 200', async () => {
    state.companyId = 1;
    for (const mgr of [OWNER, SUPER_ADMIN, FINANCE]) {
      state.houzsUser = mgr;
      const { app, env } = appWith(fixture());
      expect((await req(app, '/fair-report?stage=pnl&project=1', env)).status).toBe(200);
    }
  });
});

// ── Pure math ────────────────────────────────────────────────────────────────
describe('computeFairOverheads (pure)', () => {
  test('null rate or non-positive revenue -> all zero', () => {
    expect(computeFairOverheads({ revenueSen: 100000, cogsSen: 0, rate: null })).toEqual(emptyOverheads());
    expect(computeFairOverheads({ revenueSen: 0, cogsSen: 0, rate: BRAND_A_RATE })).toEqual(emptyOverheads());
  });

  test('boost applies only when BOTH gates pass', () => {
    // GP gate fails (COGS makes GP 10% < 40) -> normal even though sales clears.
    const lowGp = computeFairOverheads({ revenueSen: 200000, cogsSen: 180000, rate: BRAND_A_RATE });
    expect(lowGp.commission_is_boost).toBe(false);
    expect(lowGp.commission_pct).toBe(10);
    // Both gates pass -> boost.
    const boost = computeFairOverheads({ revenueSen: 200000, cogsSen: 20000, rate: BRAND_A_RATE });
    expect(boost.commission_is_boost).toBe(true);
    expect(boost.commission_pct).toBe(15);
  });

  test('sales gate is compared in RINGGIT, not centi', () => {
    // RM999.99 < RM1000 -> normal; one sen more clears it -> boost. High GP so only
    // the sales gate is in question.
    const under = computeFairOverheads({ revenueSen: 99999, cogsSen: 0, rate: BRAND_A_RATE });
    expect(under.commission_is_boost).toBe(false);
    const over = computeFairOverheads({ revenueSen: 100000, cogsSen: 0, rate: BRAND_A_RATE });
    expect(over.commission_is_boost).toBe(true);
  });

  test('a null boost_min_sales / boost_min_gp skips that gate', () => {
    const rate: FairCostRate = { ...BRAND_A_RATE, boost_min_sales: null, boost_min_gp_pct: null };
    const r = computeFairOverheads({ revenueSen: 100, cogsSen: 100, rate }); // tiny sales, zero GP
    expect(r.commission_is_boost).toBe(true); // both gates skipped -> boost
  });
});

describe('fairPnlLineCost (pure) — most-progressed COGS, null is not zero', () => {
  test('SI present -> landed cost wins', () => {
    const r = fairPnlLineCost({ amount_sen: 1000, so_cost_sen: 700, do_cost_sen: 650, si_cost_sen: 600 });
    expect(r.effective_cost_sen).toBe(600);
    expect(r.effective_cost_stage).toBe('invoice');
    expect(r.gross_profit_sen).toBe(400);
  });
  test('no SI but a DO -> DO cost wins', () => {
    const r = fairPnlLineCost({ amount_sen: 1000, so_cost_sen: 700, do_cost_sen: 650, si_cost_sen: null });
    expect(r.effective_cost_sen).toBe(650);
    expect(r.effective_cost_stage).toBe('do');
  });
  test('neither DO nor SI -> SO category cost (the committed estimate)', () => {
    const r = fairPnlLineCost({ amount_sen: 1000, so_cost_sen: 700, do_cost_sen: null, si_cost_sen: null });
    expect(r.effective_cost_sen).toBe(700);
    expect(r.effective_cost_stage).toBe('so');
  });
  test('a null do/si is skipped, never treated as a 0 cost', () => {
    // If null were read as 0, effective would be 0 and margin 100%. It must fall
    // through to the SO cost instead.
    const r = fairPnlLineCost({ amount_sen: 1000, so_cost_sen: 700, do_cost_sen: null, si_cost_sen: null });
    expect(r.effective_cost_sen).not.toBe(0);
    expect(r.margin_pct).toBeCloseTo(30);
  });
});

describe('summarizeFairPnl (pure)', () => {
  const rows: FairPnlSummaryRow[] = [
    { amount_sen: 100000, selling_sen: 70000, service_rev_sen: 30000, so_cost_sen: 50000, do_cost_sen: 52000, si_cost_sen: 54000, effective_cost_sen: 54000 },
    { amount_sen: 50000, selling_sen: 50000, service_rev_sen: 0, so_cost_sen: 20000, do_cost_sen: 21000, si_cost_sen: null, effective_cost_sen: 21000 },
  ];
  test('folds totals, counts delivered/invoiced, and nets the rate overhead', () => {
    const s = summarizeFairPnl(rows, BRAND_A_RATE);
    expect(s.orders).toBe(2);
    expect(s.delivered_orders).toBe(2);
    expect(s.invoiced_orders).toBe(1);
    expect(s.total_revenue_sen).toBe(150000);
    expect(s.total_cogs_sen).toBe(75000);
    expect(s.gross_profit_sen).toBe(75000);
    expect(s.net_profit_sen).toBe(42000);
  });
  test('empty fair -> zeros, null-safe', () => {
    const s = summarizeFairPnl([], null);
    expect(s.orders).toBe(0);
    expect(s.gross_margin_pct).toBeNull();
    expect(s.net_profit_sen).toBe(0);
  });
});
