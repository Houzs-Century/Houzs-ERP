// GET /api/project-sales-orders/:projectId — the Sales Orders written at one
// exhibition, as the project page reads them. Harness mirrors
// scm/routes/autocountRelinkRoute.test.ts: a bare Hono app whose middleware
// injects the fake-postgrest client and the caller context, mounting the
// EXPORTED handler (the router's own supabaseAuth would try to build a real
// client). The SO scope helpers are mocked at the module boundary for the
// scoped-rep case only: the fake cannot evaluate applySoScope's `ov` overlap
// term, and the rule itself is pinned by salesScope's own tests.
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Env, Variables } from '../scm/env';
import { fakeSb } from '../scm/lib/fake-postgrest';

vi.mock('../scm/lib/salesScope', () => ({
  resolveSalesScopeIds: vi.fn(async (_sb: unknown, _env: unknown, _uid: unknown, canViewAll: boolean) =>
    canViewAll ? null : ['staff-a']),
  applySoScope: (q: { in(col: string, vals: unknown[]): unknown }, ids: string[] | null) =>
    ids ? q.in('salesperson_id', ids) : q,
}));

const { projectSalesOrdersHandler, projectSalesOrderTotals } = await import('./project-sales-orders');

type Row = Record<string, unknown>;
type Caller = { accessLevel: 'full' | 'partial'; position: string | null; perms: string[] };

function harness(tables: Record<string, Row[]>, caller: Caller) {
  const sb = fakeSb(tables, {});
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('supabase', sb as unknown as Variables['supabase']);
    c.set('companyId', 1 as Variables['companyId']);
    c.set('access_level', caller.accessLevel);
    c.set('houzsUser', {
      id: 9, name: 'Tester', position_name: caller.position, permissions_set: new Set(caller.perms),
    } as unknown as Variables['houzsUser']);
    await next();
  });
  app.get('/project-sales-orders/:projectId', projectSalesOrdersHandler);
  return app;
}

const get = (app: Hono<{ Bindings: Env; Variables: Variables }>, id: string) =>
  app.request(`/project-sales-orders/${id}`);

const DIRECTOR: Caller = { accessLevel: 'full', position: 'Sales Director', perms: [] };
const REP: Caller = { accessLevel: 'partial', position: 'Sales Executive', perms: [] };

/* Fair 77 of company 1: two live orders by two reps, one draft, one cancelled;
   fair 78 and company 2 each hold an order that must never appear. */
const TABLES: Record<string, Row[]> = {
  mfg_sales_orders: [
    { doc_no: 'HC-SO-000001', company_id: 1, project_id: 77, status: 'CONFIRMED', so_date: '2026-09-18',
      ref: 'HC13503', debtor_name: 'Lim Ah Kow', phone: '0123456789', salesperson_id: 'staff-a',
      local_total_sen: 500000, total_revenue_sen: 500000, deposit_sen: 0, fair_match: 'PICKED', linked_ac_docno: null, created_at: '2026-09-18T02:00:00Z' },
    { doc_no: 'HC-SO-000002', company_id: 1, project_id: 77, status: 'CONFIRMED', so_date: '2026-09-19',
      ref: 'HC13504', debtor_name: 'Tan Mei', phone: null, salesperson_id: 'staff-b',
      local_total_sen: 300000, total_revenue_sen: 0, deposit_sen: 100000, fair_match: 'PICKED', linked_ac_docno: null, created_at: '2026-09-19T02:00:00Z' },
    { doc_no: 'HC-SO-000003', company_id: 1, project_id: 77, status: 'DRAFT', so_date: '2026-09-20',
      ref: 'HC13505', debtor_name: 'Draft Customer', phone: null, salesperson_id: 'staff-a',
      local_total_sen: 120000, total_revenue_sen: 120000, deposit_sen: 0, fair_match: null, linked_ac_docno: null, created_at: '2026-09-20T02:00:00Z' },
    { doc_no: 'HC-SO-000004', company_id: 1, project_id: 77, status: 'CANCELLED', so_date: '2026-09-20',
      ref: 'HC13506', debtor_name: 'Gone', phone: null, salesperson_id: 'staff-a',
      local_total_sen: 999900, total_revenue_sen: 999900, deposit_sen: 0, fair_match: null, linked_ac_docno: null, created_at: '2026-09-20T03:00:00Z' },
    { doc_no: 'HC-SO-000005', company_id: 1, project_id: 78, status: 'CONFIRMED', so_date: '2026-09-21',
      ref: 'HC13507', debtor_name: 'Other Fair', phone: null, salesperson_id: 'staff-a',
      local_total_sen: 700000, total_revenue_sen: 700000, deposit_sen: 0, fair_match: 'PICKED', linked_ac_docno: null, created_at: '2026-09-21T02:00:00Z' },
    { doc_no: '2990-SO-000001', company_id: 2, project_id: 77, status: 'CONFIRMED', so_date: '2026-09-18',
      ref: 'ZZ1', debtor_name: 'Other Company', phone: null, salesperson_id: 'staff-a',
      local_total_sen: 800000, total_revenue_sen: 800000, deposit_sen: 0, fair_match: 'PICKED', linked_ac_docno: null, created_at: '2026-09-18T02:00:00Z' },
  ],
  mfg_sales_order_payments: [
    { id: 'p1', company_id: 1, so_doc_no: 'HC-SO-000001', amount_sen: 200000, is_deposit: true },
    { id: 'p2', company_id: 1, so_doc_no: 'HC-SO-000001', amount_sen: 50000, is_deposit: false },
    /* The other company's ledger row for a same-numbered doc must not leak in. */
    { id: 'p3', company_id: 2, so_doc_no: 'HC-SO-000001', amount_sen: 999900, is_deposit: false },
  ],
  staff: [
    { id: 'staff-a', name: 'Anthony' },
    { id: 'staff-b', name: 'Adrian' },
  ],
};

type Body = {
  data: Array<Record<string, unknown>>;
  totals: { count: number; draft_count: number; amount_sen: number; paid_sen: number; balance_sen: number };
  scoped: boolean;
};

describe('GET /project-sales-orders/:projectId', () => {
  it('lists the fair\'s live orders of the active company, newest first, with ledger paid and staff names', async () => {
    const res = await get(harness(TABLES, DIRECTOR), '77');
    expect(res.status).toBe(200);
    const body = await res.json() as Body;
    expect(body.scoped).toBe(false);
    expect(body.data.map((r) => r.doc_no)).toEqual(['HC-SO-000003', 'HC-SO-000002', 'HC-SO-000001']);

    const first = body.data.find((r) => r.doc_no === 'HC-SO-000001')!;
    expect(first.customer_name).toBe('Lim Ah Kow');
    expect(first.salesperson_name).toBe('Anthony');
    /* paid = ledger only (the deposit is IN the ledger, so the header deposit
       is not added again); balance = total − paid, signed. */
    expect(first.amount_sen).toBe(500000);
    expect(first.paid_sen).toBe(250000);
    expect(first.balance_sen).toBe(250000);

    /* total_revenue_sen 0 → the migrated order's local_total stands; its header
       deposit never reached the ledger, so it counts as paid. */
    const second = body.data.find((r) => r.doc_no === 'HC-SO-000002')!;
    expect(second.amount_sen).toBe(300000);
    expect(second.paid_sen).toBe(100000);
    expect(second.salesperson_name).toBe('Adrian');

    expect(body.totals).toEqual({
      count: 3, draft_count: 1, amount_sen: 920000, paid_sen: 350000, balance_sen: 570000,
    });
  });

  it('holds a scoped rep to their own orders and says so', async () => {
    const res = await get(harness(TABLES, REP), '77');
    expect(res.status).toBe(200);
    const body = await res.json() as Body;
    expect(body.scoped).toBe(true);
    expect(body.data.map((r) => r.doc_no)).toEqual(['HC-SO-000003', 'HC-SO-000001']);
    expect(body.totals.count).toBe(2);
    expect(body.totals.amount_sen).toBe(620000);
  });

  it('answers an empty list, not an error, for a fair with no orders', async () => {
    const res = await get(harness(TABLES, DIRECTOR), '79');
    expect(res.status).toBe(200);
    const body = await res.json() as Body;
    expect(body.data).toEqual([]);
    expect(body.totals.count).toBe(0);
  });

  it('refuses a non-integer project id', async () => {
    const res = await get(harness(TABLES, DIRECTOR), 'abc');
    expect(res.status).toBe(400);
  });
});

describe('projectSalesOrderTotals', () => {
  it('counts drafts separately and sums the three money columns', () => {
    const t = projectSalesOrderTotals([
      { doc_no: 'a', status: 'DRAFT', amount_sen: 100, paid_sen: 0, balance_sen: 100 },
      { doc_no: 'b', status: 'CONFIRMED', amount_sen: 250, paid_sen: 50, balance_sen: 200 },
    ].map((r) => ({
      ...r, so_date: null, ref: null, customer_name: null, customer_phone: null,
      salesperson_name: null, fair_match: null, linked_ac_docno: null, created_at: null,
    })));
    expect(t).toEqual({ count: 2, draft_count: 1, amount_sen: 350, paid_sen: 50, balance_sen: 300 });
  });
});
