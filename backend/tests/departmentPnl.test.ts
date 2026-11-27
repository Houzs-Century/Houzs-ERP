/* The Department P&L through its handlers, over the fake-PostgREST harness (owner
   2026-11-19: an Operation report = his "Operation PNL - Auto" sheet, a G&A report,
   and 「我要可以看全部的，也要可以看单独部门的」). The arithmetic is
   scm/lib/department-pnl.test.ts; pinned here, with made-up figures:
     • All (owner 2026-11-25): every department's own P&L side by side on one basis —
       Performance (the orders) or Actual (the books) — the selling department paying
       G&A, Operation (which passes 3% to Logistics) and Setup & dismantle their rates
       of its sales excluding service, the departments added up, the charges even;
     • the Exhibition in Performance: the Performance P&L's sales and cost, its own
       expenses, the commission bills in place of the release, merchandise in place of
       the terminal charges, the fair transport left to Setup & dismantle;
     • Operation: the DOs by region, 7% of their value, the Logistics P&L's own 3% as
       the logistic expense, the OPERATION CHARGES bill in the month it names, the
       warehouse accounts and the warehouse teams' payroll lines;
     • G&A: its share of the Performance sales and what the HQ teams and the G&A
       accounts booked;
     • the two rates: Finance's right only, checked, saved and read back;
     • a figure opened (owner 2026-11-20: 「我希望这里点开也能看」): the lines behind every
       figure of a department's own P&L and G&A add up to it, the stock engine's
       opening stock in place of the ledger's own, nothing of another company's;
       the Operation sheet's rows are its lines added up. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import {
  departmentLinesHandler, departmentUnitHandler, departmentViewHandler, departmentsAllHandler, departmentsGaHandler, departmentsOperationHandler, departmentsPlanHandler,
  saveDepartmentRateHandler, saveSupplierRebatesHandler,
} from '../src/scm/routes/acc-departments';
import { logisticsPnlHandler } from '../src/scm/routes/acc-logistics-pnl';

const CO = 1;
const account = (account_code: string, account_name: string, section: string, extra: Row = {}): Row => ({
  company_id: CO, account_code, account_name, section, is_active: true, parent_code: null,
  account_type: section === 'SALES' || section === 'OTHER INCOMES' ? 'INCOME' : 'EXPENSE', logistics_row: null, department_row: null, ...extra,
});
let seq = 0;
const gl = (account_code: string, debit_sen: number, credit_sen: number, over: Row = {}): Row => ({
  company_id: CO, line_id: `g${++seq}`, account_code, account_name: account_code, account_type: 'EXPENSE', debit_sen, credit_sen,
  entry_date: '2026-09-15', posted: true, reversed: false, reversed_by_je: null, opening: false, notes: null, je_no: `JE-${seq}`, ...over,
});

const ACCOUNTS: Row[] = [
  account('501-0000', 'SALES', 'SALES'),
  account('599-0000', 'ADDITIONAL INCOME', 'OTHER INCOMES'),
  account('900-S100', 'STAFF SALARIES & OVERTIME', 'EXPENSES'),
  account('900-D100', 'DIRECTOR REMUNERATION', 'EXPENSES', { department_row: 'ga' }),
  account('900-P001', 'PRINTING & STATIONERY', 'EXPENSES', { department_row: 'ga' }),
  account('900-R004', 'WAREHOUSE - (PENANG)', 'EXPENSES', { department_row: 'op_rental_pg' }),
  account('900-R005', 'WAREHOUSE - (BELAKONG)', 'EXPENSES', { department_row: 'op_rental_kl' }),
  account('900-T005', 'TRANSPORT (PNG, PERLIS, KEDAH, KELATAN, TERENGGANU, PAHANG)', 'EXPENSES', { logistics_row: 'outsource_pg' }),
  account('900-B003', 'BOOTH SET UP', 'EXPENSES', { department_row: 'exhibition' }),
  account('900-R009', 'SHOW ROOM (KELANA JAYA)', 'EXPENSES', { department_row: 'showroom' }),
  account('900-A004', 'ADVERTISEMENT - MANAGEMENT FEES', 'EXPENSES', { department_row: 'hire' }),
  account('900-U014', 'UPKEEP OF LORI - VRH 9058', 'EXPENSES'),
];

const LEDGER: Row[] = [
  gl('501-0000', 0, 5_000_000, { account_type: 'INCOME' }),
  gl('599-0000', 0, 70_000, { account_type: 'INCOME', notes: "OPERATION CHARGES - AUG'26" }),
  gl('599-0000', 0, 40_000, { account_type: 'INCOME', notes: "LOGISTICS CHARGES - AUG'26" }),
  gl('599-0000', 0, 1_000, { account_type: 'INCOME', notes: 'SUNDRY' }),
  gl('900-S100', 80_000, 0, { notes: "FINANCE - SALARY - SEP'26", entry_date: '2026-09-30' }),
  gl('900-S100', 50_000, 0, { notes: "OPERATION HELPER SALARY - SEPT'26", entry_date: '2026-09-30' }),
  gl('900-S100', 90_000, 0, { notes: "WAREHOUSE OPERATIONS SALARY - SEPT'26", entry_date: '2026-09-30' }),
  gl('900-S100', 30_000, 0, { notes: "OPERATION STOREKEEPER PG SALARY - SEPT'26", entry_date: '2026-09-30' }),
  gl('900-S100', 20_000, 0, { notes: "GROSS SALARY - SEP'26", entry_date: '2026-09-30' }),
  gl('900-D100', 200_000, 0, { notes: "SALARY - SEP'26" }),
  gl('900-P001', 5_000, 0),
  gl('900-P001', 9_999, 0, { reversed: true }),                  // undone by its contra —
  gl('900-P001', 0, 9_999, { reversed_by_je: 'JE-X' }),          // the pair counts nowhere
  gl('900-R004', 180_000, 0, { entry_date: '2026-09-07' }),
  gl('900-R005', 270_000, 0, { entry_date: '2026-09-07' }),
  gl('900-T005', 150_000, 0),
  gl('900-B003', 400_000, 0),
  gl('900-R009', 220_000, 0, { entry_date: '2026-09-07' }),
  gl('900-A004', 6_000, 0, { notes: 'WAREHOUSE ASSISTANT - AUG26' }),
  gl('900-A004', 2_500, 0, { notes: 'ACCOUNT EXECUTIVE - AUG26' }),
  gl('900-U014', 20_000, 0),
];
/* Houzs's plan (migration 20261119T2310): its showroom counts in G&A. */
const HOUZS_PLAN = { departments: ['exhibition', 'operation', 'logistics', 'ga'], selling: 'exhibition', folds: { showroom: 'ga' } };

const world = (over: Record<string, Row[]> = {}) => fakeSb({
  accounts: ACCOUNTS.map((r) => ({ ...r })),
  v_gl_entries: LEDGER.map((r) => ({ ...r })),
  acc_report_layouts: [], inventory_movements: [], warehouses: [], acc_account_roles: [], journal_entries: [], acc_company_settings: [],
  acc_department_settings: [{ company_id: CO, ga_share_bp: 800, operation_income_bp: 700, plan: HOUZS_PLAN }],
  lorries: [], acc_logistics_settings: [], acc_logistics_spreads: [], acc_logistics_area_rates: [], acc_logistics_trip_marks: [],
  delivery_orders: [
    { id: 'd1', company_id: CO, do_number: 'HC-DO-1', so_doc_no: null, status: 'LOADED', state: 'Selangor', do_date: '2026-09-10', customer_delivery_date: null },
    { id: 'd2', company_id: CO, do_number: 'HC-DO-2', so_doc_no: null, status: 'LOADED', state: 'Penang', do_date: '2026-09-12', customer_delivery_date: null },
  ],
  delivery_order_crew: [],
  delivery_order_items: [
    { id: 'i1', delivery_order_id: 'd1', company_id: CO, line_total_sen: 3_000_000 },
    { id: 'i2', delivery_order_id: 'd2', company_id: CO, line_total_sen: 1_000_000 },
  ],
  threepl_do_charges: [], threepl_bill_lines: [], ap_invoices: [], suppliers: [], threepl_companies: [],
  mfg_sales_orders: [{ company_id: CO, doc_no: 'HC-SO-1', so_date: '2026-09-05', status: 'CONFIRMED', delivery_fee_sen: 0 }],
  mfg_sales_order_items: [{ company_id: CO, doc_no: 'HC-SO-1', item_group: 'BEDFRAME', item_code: 'BF-1', qty: 1, total_sen: 2_500_000, unit_cost_sen: 1_000_000, line_cost_sen: 1_000_000, cancelled: false }],
  acc_debtors: [{ id: 'dt1', company_id: CO, name: '2990 HOME SDN BHD' }],
  acc_debtor_bills: [{ id: 'b1', company_id: CO, bill_number: 'HC-ODB-2610-001', bill_date: '2026-10-23', status: 'POSTED', debtor_id: 'dt1' }],
  acc_debtor_bill_lines: [
    { id: 'bl1', company_id: CO, bill_id: 'b1', line_no: 1, description: "OPERATION CHARGES - SEP'26", credit_account_code: '599-0000', amount_sen: 70_000 },
    { id: 'bl2', company_id: CO, bill_id: 'b1', line_no: 2, description: "LOGISTICS CHARGES - SEP'26", credit_account_code: '599-0000', amount_sen: 40_000 },
  ],
  ...over,
});

function harness(sb: ReturnType<typeof world>, perms: string[] = ['scm.payment_voucher.post']) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { id: 7, name: 'Finance', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    await next();
  });
  app.get('/departments/plan', departmentsPlanHandler as never);
  app.get('/departments/dept', departmentViewHandler as never);
  app.get('/departments/all', departmentsAllHandler as never);
  app.get('/departments/ga', departmentsGaHandler as never);
  app.get('/departments/operation', departmentsOperationHandler as never);
  app.get('/departments/unit', departmentUnitHandler as never);
  app.get('/departments/lines', departmentLinesHandler as never);
  app.get('/logistics/pnl', logisticsPnlHandler as never);
  app.put('/departments/rate', saveDepartmentRateHandler as never);
  app.put('/departments/rebates', saveSupplierRebatesHandler as never);
  const get = async (path: string) => { const r = await app.request(path); return { status: r.status, body: await r.json() as any }; };
  const putAt = async (path: string, body: unknown) => {
    const r = await app.request(path, { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    return { status: r.status, body: await r.json() as any };
  };
  const put = (body: unknown) => putAt('/departments/rate', body);
  return { get, put, putAt };
}
const SEP = '?from=2026-09-01&to=2026-09-30';

const SEP_AND = SEP.replace('?', '&');
const nodes = (ns: any[]): any[] => ns.flatMap((n: any) => [n, ...nodes(n.children ?? [])]);
const leaf = (ns: any[], code: string): any => nodes(ns).find((n: any) => n.kind === 'account' && n.code === code);

describe("GET /departments/all — every department's own P&L, side by side (owner 2026-11-25)", () => {
  const sum = (u: any, keep: (r: any) => boolean) => u.rows.filter(keep).reduce((a: number, r: any) => a + (r.cells['2026-09'] ?? 0), 0);
  const cell = (u: any, key: string) => u.rows.find((r: any) => r.key === key)?.cells['2026-09'] ?? 0;

  test('Performance (no basis named): the Exhibition on its orders pays G&A and Operation; each column its own view; the charges come out even', async () => {
    const h = harness(world());
    const { status, body } = await h.get(`/departments/all${SEP}`);
    expect(status).toBe(200);
    expect(body.basis).toBe('performance');
    expect(body.departments.map((x: any) => [x.key, x.view])).toEqual([['exhibition', 'dept'], ['operation', 'operation'], ['logistics', 'logistics'], ['ga', 'ga']]);
    expect(body.branches).toEqual([]);
    expect(body.rates).toEqual({ gaBp: 800, operationBp: 700, logisticsBp: 300, setupDismantleBp: 100, merchandiseBp: 0 });
    /* The order's 2,500,000 (not the books' 5,000,000): 8% to G&A, 7% to Operation. */
    expect(body.summary.exhibition).toEqual({
      incomeSen: 2_500_000, costSen: 1_000_000, grossSen: 1_500_000, otherIncomeSen: 0, expensesSen: 420_000, chargesSen: 375_000, profitSen: 705_000,
    });
    const own = (await h.get(`/departments/dept?d=exhibition${SEP_AND}`)).body.perMonth[0];
    expect(body.summary.exhibition.profitSen).toBe(own.netSen);
    /* Operation: its 7% and what it billed, less the 3% to Logistics and the warehouse (its sheet's rows). */
    const op = (await h.get(`/departments/unit?u=operation${SEP_AND}`)).body;
    expect(cell(op, 'from_selling')).toBe(175_000);
    expect(cell(op, 'to_logistics')).toBe(75_000);
    expect(body.summary.operation).toEqual({
      incomeSen: 175_000 + 70_000, costSen: 0, grossSen: 245_000, otherIncomeSen: 0, expensesSen: 576_000, chargesSen: 75_000, profitSen: 245_000 - 75_000 - 576_000,
    });
    /* Logistics: the 3% from Operation and Finance's recharges — never its report's own 3% of DO — less the delivery cost. */
    const lgRep = (await h.get(`/logistics/pnl${SEP}`)).body;
    const row = (k: string) => lgRep.rows.find((r: any) => r.key === k)?.totalSen ?? 0;
    const lg = (await h.get(`/departments/unit?u=logistics${SEP_AND}`)).body;
    expect(cell(lg, 'from_operation')).toBe(75_000);
    expect(body.summary.logistics).toMatchObject({
      incomeSen: 75_000 + row('ti_houzs') + row('ti_conts') + row('ti_hookka') + row('ti_2990'), expensesSen: row('total_expense'), chargesSen: 0,
    });
    expect(body.summary.logistics.profitSen).toBe(lg.perMonth[0].netSen);
    /* G&A: 8% of the order's sales excluding service against what it booked. */
    expect(body.summary.ga).toEqual({ incomeSen: 200_000, costSen: 0, grossSen: 200_000, otherIncomeSen: 0, expensesSen: 507_500, chargesSen: 0, profitSen: -307_500 });
    /* What the Exhibition pays is what G&A and Operation are paid; what Operation passes on, Logistics is paid. */
    expect(body.summary.exhibition.chargesSen).toBe(body.summary.ga.incomeSen + cell(op, 'from_selling'));
    expect(body.summary.operation.chargesSen).toBe(cell(lg, 'from_operation'));
    for (const k of ['incomeSen', 'costSen', 'grossSen', 'otherIncomeSen', 'expensesSen', 'chargesSen', 'profitSen']) {
      expect(body.total[k], k).toBe(['exhibition', 'operation', 'logistics', 'ga'].reduce((a, d) => a + body.summary[d][k], 0));
    }
    expect(body.unassigned).toEqual({ label: 'No department yet', lines: [{ code: '900-U014', name: '900-U014', amountSen: 20_000 }] });
    expect(sum(op, (r: any) => r.group === 'expense')).toBe(576_000);
  });

  test("Actual: the same arithmetic on the selling department's sales as booked", async () => {
    const h = harness(world());
    const { body } = await h.get(`/departments/all?dbasis=actual${SEP_AND}`);
    expect(body.basis).toBe('actual');
    expect(body.summary.exhibition).toMatchObject({ incomeSen: 5_000_000, expensesSen: 420_000, chargesSen: 400_000 + 350_000 });
    expect(body.summary.ga).toMatchObject({ incomeSen: 400_000, expensesSen: 507_500 });
    expect(body.summary.operation).toMatchObject({ incomeSen: 350_000 + 70_000, chargesSen: 150_000 });
    const own = (await h.get(`/departments/dept?d=exhibition&dbasis=actual${SEP_AND}`)).body;
    expect(own.basis).toBe('actual');
    expect(own.orders).toBeNull();
    expect(body.summary.exhibition.profitSen).toBe(own.perMonth[0].netSen);
    expect((await h.get(`/departments/all?dbasis=books${SEP_AND}`)).body.error).toBe('bad_basis');
  });

  test("a shop's departments: the Showroom sells and pays G&A only, on its orders or as booked", async () => {
    const shop = world({ acc_department_settings: [{ company_id: CO, ga_share_bp: 800, plan: { departments: ['showroom', 'ga'], selling: 'showroom', folds: { exhibition: 'showroom', operation: 'showroom', logistics: 'showroom' } } }] });
    const h = harness(shop);
    const { body } = await h.get(`/departments/all${SEP}`);
    expect(body.departments.map((x: any) => [x.key, x.view])).toEqual([['showroom', 'dept'], ['ga', 'ga']]);
    expect(body.summary.showroom).toMatchObject({ incomeSen: 2_500_000, chargesSen: 200_000 });
    const own = (await h.get(`/departments/dept?d=showroom${SEP_AND}`)).body;
    expect(own.charges.map((n: any) => n.id)).toEqual(['charge:ga']);
    expect(body.summary.showroom.profitSen).toBe(own.perMonth[0].netSen);
    expect(Object.keys(body.summary)).toEqual(['showroom', 'ga']);
    const actual = (await h.get(`/departments/all?dbasis=actual${SEP_AND}`)).body;
    expect(actual.summary.showroom).toMatchObject({ incomeSen: 5_000_000, chargesSen: 400_000 });
  });

  test("the statements' right only", async () => {
    expect((await harness(world(), ['scm.access']).get(`/departments/all${SEP}`)).status).toBe(403);
  });
});

describe('Setup & dismantle and merchandise (owner 2026-11-25: 1% for the setup and dismantle transport, never the booth setup)', () => {
  /* Houzs keeps its charge accounts: merchandise 2% in place of the terminal charges, the fair transport for Setup & dismantle. */
  const fairs = () => world({
    accounts: [
      ...ACCOUNTS.map((r) => ({ ...r })),
      account('503-0000', 'SERVICE INCOME', 'SALES'),
      account('900-T009', 'TERMINAL INTEREST CHARGES', 'EXPENSES', { department_row: 'exhibition' }),
      account('900-T031', 'TRANSPORT FAIR (KL, SLG, MLK, JHR, OTHERS)', 'EXPENSES', { department_row: 'exhibition' }),
    ],
    v_gl_entries: [
      ...LEDGER.map((r) => ({ ...r })),
      gl('503-0000', 0, 200_000, { account_type: 'INCOME' }),
      gl('900-T009', 7_000, 0, { account_name: 'TERMINAL INTEREST CHARGES' }),
      gl('900-T031', 30_000, 0, { notes: 'LORRY TO KL FAIR - SETUP' }),
    ],
    acc_department_settings: [{
      company_id: CO, ga_share_bp: 500, operation_income_bp: 700, plan: HOUZS_PLAN,
      charges: { merchandiseBp: 200, merchandise: ['900-T009'], setupDismantle: ['900-T030', '900-T031'] },
    }],
    acc_item_group_accounts: [
      { company_id: CO, group_code: 'BEDFRAME', sales_account: '501-0000', sales_return_account: '510-0000' },
      { company_id: CO, group_code: 'SERVICE', sales_account: '503-0000', sales_return_account: '510-0000' },
    ],
    mfg_sales_order_items: [
      { company_id: CO, doc_no: 'HC-SO-1', item_group: 'BEDFRAME', item_code: 'BF-1', qty: 1, total_sen: 2_500_000, unit_cost_sen: 1_000_000, line_cost_sen: 1_000_000, cancelled: false },
      { company_id: CO, doc_no: 'HC-SO-1', item_group: 'SERVICE', item_code: 'SVC-DELIVERY', qty: 1, total_sen: 100_000, unit_cost_sen: 0, line_cost_sen: 0, cancelled: false },
    ],
  });

  test('Performance: the rates of the sales excluding service; merchandise in place of the terminal charges; the fair transport leaves the Exhibition', async () => {
    const h = harness(fairs());
    expect((await h.get('/departments/plan')).body.branches).toEqual([{ key: 'setupDismantle', label: 'Setup & dismantle', under: 'logistics' }]);
    const d = (await h.get(`/departments/dept?d=exhibition${SEP_AND}`)).body;
    expect(d.perMonth[0]).toMatchObject({ salesSen: 2_600_000, baseSen: 2_500_000, chargesSen: 125_000 + 175_000 + 25_000 });
    expect(d.charges.map((n: any) => [n.id, n.amountSen])).toEqual([['charge:ga', 125_000], ['charge:operation', 175_000], ['charge:setupDismantle', 25_000]]);
    const merch = leaf(d.tree.expenses, '900-T009');
    expect(merch.amountSen).toBe(50_000);
    expect(merch.label).toBe('Merchandise — 2% of sales excluding service, in place of 900-T009 TERMINAL INTEREST CHARGES (RM 70.00 booked)');
    expect(leaf(d.tree.expenses, '900-T031')).toBeUndefined();
    /* Merchandise opens its months at the rate; the fair transport is no longer the Exhibition's. */
    const m = (await h.get(`/departments/lines?view=dept&d=exhibition&block=expenses&keys=900-T009,900-T031${SEP_AND}`)).body;
    expect(m.lines.map((l: any) => [l.source, l.accountCode, l.sen])).toEqual([['rate', '900-T009', 50_000]]);
    /* Setup & dismantle: its 1% less the fair transport as booked (no in-house trip here: the fairs are not reachable). */
    const sd = (await h.get(`/departments/unit?u=setupDismantle${SEP_AND}`)).body;
    expect(sd.rows.map((r: any) => [r.key, r.cells['2026-09']])).toEqual([['from_selling', 25_000], ['900-T031', 30_000]]);
    expect(sd.perMonth[0].netSen).toBe(-5_000);
    const t031 = (await h.get(`/departments/lines?view=sd&keys=900-T031${SEP_AND}`)).body;
    expect(t031.lines.map((l: any) => [l.text, l.sen])).toEqual([['LORRY TO KL FAIR - SETUP', 30_000]]);
    expect((await h.get(`/departments/lines?view=sd&keys=900-B003${SEP_AND}`)).body.error).toBe('bad_keys');
    const all = (await h.get(`/departments/all${SEP}`)).body;
    expect(all.summary.setupDismantle).toMatchObject({ incomeSen: 25_000, expensesSen: 30_000, profitSen: -5_000 });
    expect(all.total.profitSen).toBe(Object.values(all.summary).reduce((a: number, x: any) => a + x.profitSen, 0));
  });

  test('Actual: the terminal charges as booked, the service income out of the base', async () => {
    const h = harness(fairs());
    const d = (await h.get(`/departments/dept?d=exhibition&dbasis=actual${SEP_AND}`)).body;
    expect(d.perMonth[0]).toMatchObject({ salesSen: 5_200_000, baseSen: 5_000_000, chargesSen: 250_000 + 350_000 + 50_000, expensesSen: 400_000 + 20_000 + 7_000 });
    expect(leaf(d.tree.expenses, '900-T009').amountSen).toBe(7_000);
    const lines = (await h.get(`/departments/lines?view=dept&d=exhibition&block=expenses&dbasis=actual&keys=900-T009${SEP_AND}`)).body;
    expect(lines.lines.map((l: any) => [l.source, l.sen])).toEqual([['ledger', 7_000]]);
    const ga = (await h.get(`/departments/ga?dbasis=actual${SEP_AND}`)).body;
    expect(ga.perMonth[0]).toMatchObject({ salesSen: 5_000_000, shareSen: 250_000 });
  });

  test('a company with no Setup & dismantle has no such P&L; a unit must be one of the three', async () => {
    const h = harness(world());
    expect((await h.get(`/departments/unit?u=setupDismantle${SEP_AND}`)).body.error).toBe('bad_department');
    expect((await h.get(`/departments/unit?u=ga${SEP_AND}`)).body.error).toBe('bad_unit');
  });
});

describe('GET /departments/unit — Operation: its rows are the sheet\'s lines added up', () => {
  test('every row but the charges opens the lines that make it', async () => {
    const { body } = await harness(world()).get(`/departments/unit?u=operation${SEP_AND}`);
    for (const r of body.rows.filter((x: any) => x.key !== 'from_selling' && x.key !== 'to_logistics')) {
      const total = body.lines.filter((l: any) => l.row === r.key).reduce((a: number, l: any) => a + l.cells.PG + l.cells.KL + l.cells.EM, 0);
      expect(total, r.key).toBe(r.cells['2026-09']);
    }
    expect(body.base).toEqual({ '2026-09': 2_500_000 });
  });
});

describe('GET /departments/plan and /departments/dept — the company\'s departments, one at a time', () => {
  test("the Exhibition P&L in Performance: the Performance P&L's sales and cost, less what Exhibition booked and what it pays, month by month", async () => {
    const h = harness(world());
    const plan = await h.get('/departments/plan');
    expect(plan.body.departments.map((x: any) => x.label)).toEqual(['Exhibition', 'Operation', 'Logistics', 'G&A']);
    const { status, body } = await h.get(`/departments/dept?d=exhibition&from=2026-09-01&to=2026-09-30`);
    expect(status).toBe(200);
    expect(body.label).toBe('Exhibition');
    expect(body.basis).toBe('performance');
    expect(body.orders).toEqual({ counted: 1, notDelivered: 1 });
    expect(body.perMonth).toEqual([{
      month: '2026-09', salesSen: 2_500_000, costOfSalesSen: 1_000_000, grossSen: 1_500_000, otherIncomeSen: 0,
      expensesSen: 400_000 + 20_000, taxationSen: 0, chargesSen: 200_000 + 175_000, baseSen: 2_500_000, netSen: 1_500_000 - 420_000 - 375_000,
    }]);
    expect(body.charges.map((n: any) => [n.id, n.amountSen])).toEqual([['charge:ga', 200_000], ['charge:operation', 175_000]]);
    expect(body.tree.tradingIncome.map((n: any) => [n.key, n.label, n.amountSen])).toEqual([['order:bedframe', 'Bedframe', 2_500_000]]);
    expect(body.tree.costOfSales.map((n: any) => [n.key, n.amountSen])).toEqual([['order:bedframe', 1_000_000]]);
    expect((await h.get(`/departments/dept?d=showroom${SEP_AND}`)).body.error).toBe('bad_department');
  });

  test("the commission: the month's bills in place of the release, what else is booked on it kept; its lines are the bill and the rest", async () => {
    const h = harness(world({
      accounts: [
        ...ACCOUNTS.map((r) => ({ ...r })),
        account('900-C003', 'COMMISSION ( EVENT )', 'EXPENSES', { department_row: 'sales' }),
        account('360-0050', 'PREPAYMENT COMMISSION', 'CURRENT ASSETS', { account_type: 'ASSET' }),
      ],
      v_gl_entries: [
        ...LEDGER.map((r) => ({ ...r })),
        /* September's commission bill, booked in October; the release of September and its leg on the prepayment; an overriding booked straight. */
        gl('360-0050', 1_500_000, 0, { account_type: 'ASSET', notes: "REVENUE TEAM PAYROLL TO COLLECT BACK - SEP'26", entry_date: '2026-10-15', source_type: 'API', source_doc_no: 'HC-API-1' }),
        gl('900-C003', 600_000, 0, { entry_date: '2026-09-30', source_type: 'COMMREL', notes: 'COMMISSION RELEASE - SEP 2026' }),
        gl('360-0050', 0, 600_000, { account_type: 'ASSET', entry_date: '2026-09-30', source_type: 'COMMREL' }),
        gl('900-C003', 30_000, 0, { entry_date: '2026-09-20', notes: 'OVERRIDING - SEP' }),
      ],
    }));
    const body = (await h.get(`/departments/dept?d=exhibition${SEP_AND}`)).body;
    const c003 = leaf(body.tree.expenses, '900-C003');
    expect(c003.amountSen).toBe(30_000 + 1_500_000);
    expect(c003.label).toBe('900-C003 COMMISSION ( EVENT ) — the commission bills for Sep 2026, in place of the monthly release');
    expect(body.perMonth[0].expensesSen).toBe(420_000 + 1_530_000);
    const lines = (await h.get(`/departments/lines?view=dept&d=exhibition&block=expenses&keys=900-C003${SEP_AND}`)).body;
    expect(lines.lines.map((l: any) => [l.source, l.accountCode, l.text, l.sen])).toEqual([
      ['ledger', '900-C003', 'OVERRIDING - SEP', 30_000],
      ['bill', '360-0050', "REVENUE TEAM PAYROLL TO COLLECT BACK - SEP'26", 1_500_000],
    ]);
    expect(lines.totalSen).toBe(c003.amountSen);
  });

  test('a company with no Operation department has no Operation sheet', async () => {
    const shop = world({ acc_department_settings: [{ company_id: CO, plan: { departments: ['showroom', 'ga'], selling: 'showroom', folds: { operation: 'showroom' } } }] });
    const res = await harness(shop).get(`/departments/operation${SEP}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_department');
  });
});

describe('GET /departments/operation — the Operation sheet', () => {
  test('September by region from the books', async () => {
    const { status, body } = await harness(world()).get(`/departments/operation${SEP}`);
    expect(status).toBe(200);
    expect(body.months).toEqual(['2026-09']);
    expect(body.regions.map((r: any) => r.code)).toEqual(['PG', 'KL', 'EM']);
    const rows = body.perMonth[0].rows;
    expect(rows.do_value).toEqual({ PG: 1_000_000, KL: 3_000_000, EM: 0 });
    expect(rows.do_income).toEqual({ PG: 70_000, KL: 210_000, EM: 0 });
    expect(rows.logistic_expense).toEqual({ PG: -30_000, KL: -90_000, EM: 0 });
    expect(rows.income_2990).toEqual({ PG: 0, KL: 70_000, EM: 0 });
    expect(rows.rental).toEqual({ PG: 180_000, KL: 270_000, EM: 0 });
    /* Shared by the DO value 1 : 3; the storekeeper line names Penang. */
    expect(rows.manpower_operation).toEqual({ PG: 22_500, KL: 67_500, EM: 0 });
    expect(rows.manpower_storekeeper).toEqual({ PG: 30_000, KL: 0, EM: 0 });
    /* The warehouse assistant's job ad: the sheet's job-ads row, in KL. */
    expect(rows.recruitment).toEqual({ PG: 0, KL: 6_000, EM: 0 });
    expect(rows.total_expense).toEqual({ PG: 180_000 + 22_500 + 30_000, KL: 270_000 + 67_500 + 6_000, EM: 0 });
    expect(body.rows.find((r: any) => r.key === 'do_income').label).toBe('7% Income from Delivery Order');
    expect(body.rows.find((r: any) => r.key === 'manpower_storekeeper').label).toBe('Warehouse Manpower - Storekeeper');
    expect(body.rows.find((r: any) => r.key === 'rental').label).toBe('Rental Warehouse');
    expect(body.logisticsIncomeBp).toBe(300);
    expect(body.logisticsProblem).toBe('the fairs are not reachable from here');
    expect(body.income.map((l: any) => [l.billNo, l.month, l.key])).toEqual([['HC-ODB-2610-001', '2026-09', 'income_2990']]);
  });
});

describe('GET /departments/ga — G&A against its share', () => {
  test("8% of the Performance sales against the HQ teams' pay and the G&A accounts", async () => {
    const { status, body } = await harness(world()).get(`/departments/ga${SEP}`);
    expect(status).toBe(200);
    expect(body.shareBp).toBe(800);
    const sep = body.perMonth[0];
    expect(sep.salesSen).toBe(2_500_000);
    expect(sep.shareSen).toBe(200_000);
    /* Finance's team line, the director's pay, the printing, the showroom (Houzs's folds into G&A) and the
       account executive's job ad — not the warehouse, the drivers, the warehouse ad or the selling staff. */
    expect(sep.expenseSen).toBe(80_000 + 200_000 + 5_000 + 220_000 + 2_500);
    expect(sep.surplusSen).toBe(200_000 - 507_500);
    expect(body.teams.map((t: any) => t.team)).toEqual(['FINANCE']);
  });
});

describe('GET /departments/lines — the lines behind a figure add up to it', () => {
  const BLOCKS = ['tradingIncome', 'costOfSales', 'otherIncome', 'expenses', 'taxation'] as const;
  const leaves = (n: any): string[] => (n.kind === 'account' ? [n.key ?? n.code] : (n.children ?? []).flatMap(leaves));
  const keysOf = (n: any) => encodeURIComponent(leaves(n).join(','));
  /* Houzs's books start on 1 September with opening stock; the ledger's own stock line is the P&L's to set aside. */
  const booked = (over: Record<string, Row[]> = {}) => world({
    acc_company_settings: [{ company_id: CO, books_start_date: '2026-09-01', opening_stock: { customer: 300_000 } }],
    v_gl_entries: [
      ...LEDGER.map((r) => ({ ...r })),
      gl('600-0001', 77_777, 0, { entry_date: '2026-09-30', notes: 'MONTH CLOSE' }),
      gl('900-P001', 123_456, 0, { company_id: 2, line_id: 'other-co' }),
      gl('900-P001', 1_500, 0, { entry_date: '2026-10-12' }),
      gl('900-S100', 60_000, 0, { notes: "IT SALARY - OCT'26", entry_date: '2026-10-31' }),
    ],
    ...over,
  });

  /* 2990's plan: its Showroom sells and reads its books, everything else folds into it. */
  const SHOP_PLAN = { departments: ['showroom', 'ga'], selling: 'showroom', folds: { exhibition: 'showroom', operation: 'showroom', logistics: 'showroom' } };
  const shop = () => booked({ acc_department_settings: [{ company_id: CO, ga_share_bp: 800, plan: SHOP_PLAN }] });

  test('a department as booked (the Showroom): every account, category and block, each month and the Total', async () => {
    const h = harness(shop());
    const both = '&from=2026-09-01&to=2026-10-31';
    const months = ['2026-09', '2026-10'];
    const range = (m: string | null) => (m ? `&from=${m}-01&to=${m === '2026-09' ? '2026-09-30' : '2026-10-31'}` : both);
    const dept = (await h.get(`/departments/dept?d=showroom&dbasis=actual${both}`)).body;
    expect(dept.basis).toBe('actual');
    let checked = 0;
    for (const block of BLOCKS) {
      for (const n of nodes(dept.tree[block])) {
        for (const m of [...months, null]) {
          const res = await h.get(`/departments/lines?view=dept&d=showroom&dbasis=actual&block=${block}&keys=${keysOf(n)}${range(m)}`);
          expect(res.status).toBe(200);
          const cell = m ? (n.cells?.[m] ?? 0) : months.reduce((x, k) => x + (n.cells?.[k] ?? 0), 0);
          expect(res.body.totalSen, `${block} ${n.id} ${m ?? 'Total'}`).toBe(cell);
          expect(res.body.lines.reduce((x: number, l: any) => x + l.sen, 0)).toBe(cell);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
    /* Opening stock is the books' own, not the ledger's month-close line on the same account. */
    const stock = await h.get(`/departments/lines?view=dept&d=showroom&dbasis=actual&block=costOfSales&keys=600-0001${SEP.replace('?', '&')}`);
    expect(stock.body.lines.map((l: any) => [l.source, l.sen, l.dept])).toEqual([['stock_opening', 300_000, 'showroom']]);
  });

  test("the Exhibition on its orders and G&A: each month's figure and the Total, row by row; the orders' figures open no ledger line", async () => {
    const h = harness(booked());
    const both = '&from=2026-09-01&to=2026-10-31';
    const months = ['2026-09', '2026-10'];
    const range = (m: string | null) => (m ? `&from=${m}-01&to=${m === '2026-09' ? '2026-09-30' : '2026-10-31'}` : both);
    const dept = (await h.get(`/departments/dept?d=exhibition${both}`)).body;
    for (const block of BLOCKS) {
      for (const n of nodes(dept.tree[block])) {
        for (const m of [...months, null]) {
          const res = await h.get(`/departments/lines?view=dept&d=exhibition&block=${block}&keys=${keysOf(n)}${range(m)}`);
          if (block === 'tradingIncome' || block === 'costOfSales') {
            expect(res.body.error, `${block} ${n.id}`).toBe('from_orders');
            continue;
          }
          const cell = m ? (n.cells?.[m] ?? 0) : months.reduce((x, k) => x + (n.cells?.[k] ?? 0), 0);
          expect(res.body.totalSen, `${block} ${n.id} ${m ?? 'Total'}`).toBe(cell);
        }
      }
    }
    /* The payroll account's Exhibition figure: the line naming no team, nothing else. */
    const pay = await h.get(`/departments/lines?view=dept&d=exhibition&block=expenses&keys=900-S100${SEP.replace('?', '&')}`);
    expect(pay.body.lines.map((l: any) => [l.text, l.sen, l.dept])).toEqual([["GROSS SALARY - SEP'26", 20_000, 'exhibition']]);
    const ga = (await h.get(`/departments/ga?${both.slice(1)}`)).body;
    for (const n of nodes(ga.tree)) {
      for (const m of [...months, null]) {
        const res = await h.get(`/departments/lines?view=ga&keys=${keysOf(n)}${range(m)}`);
        const cell = m ? (n.cells?.[m] ?? 0) : months.reduce((x, k) => x + (n.cells?.[k] ?? 0), 0);
        expect(res.body.totalSen, `G&A ${n.id} ${m ?? 'Total'}`).toBe(cell);
      }
    }
    const it = await h.get(`/departments/lines?view=ga&keys=team:IT${both}`);
    expect(it.body.lines.map((l: any) => [l.team, l.text, l.sen])).toEqual([['IT', "IT SALARY - OCT'26", 60_000]]);
  });

  test("only the company's own lines", async () => {
    const h = harness(booked());
    const res = await h.get(`/departments/lines?view=ga&keys=900-P001${SEP.replace('?', '&')}`);
    expect(res.body.lines.map((l: any) => l.id)).not.toContain('other-co');
    expect(res.body.totalSen).toBe(5_000);
    const own = await h.get(`/departments/lines?view=dept&d=ga&block=expenses&keys=900-P001${SEP.replace('?', '&')}`);
    expect(own.body.totalSen).toBe(5_000);
  });

  test('the statements\' right only; a view, a block, a department and accounts that make sense', async () => {
    expect((await harness(world(), ['scm.access']).get(`/departments/lines?view=ga&keys=900-P001${SEP.replace('?', '&')}`)).status).toBe(403);
    const h = harness(world());
    const q = SEP.replace('?', '&');
    expect((await h.get(`/departments/lines?view=operation&keys=900-P001${q}`)).body.error).toBe('bad_view');
    expect((await h.get(`/departments/lines?view=ga&dbasis=orders&keys=900-P001${q}`)).body.error).toBe('bad_basis');
    /* All is the departments' own P&Ls side by side: a department's figures open in its own view. */
    expect((await h.get(`/departments/lines?view=all&block=expenses&keys=900-P001${q}`)).body.error).toBe('bad_view');
    expect((await h.get(`/departments/lines?view=ga${q}`)).body.error).toBe('bad_keys');
    expect((await h.get(`/departments/lines?view=dept&d=ga&block=assets&keys=900-P001${q}`)).body.error).toBe('bad_block');
    expect((await h.get(`/departments/lines?view=dept&d=showroom&block=expenses&keys=900-P001${q}`)).body.error).toBe('bad_department');
    expect((await h.get(`/departments/lines?view=dept&d=logisticsx&block=expenses&keys=900-P001${q}`)).body.error).toBe('bad_department');
  });

  test('the Operation sheet: its rows are its lines added up, each line saying where it comes from', async () => {
    const { body } = await harness(world()).get(`/departments/operation${SEP}`);
    const results = new Set(['gross', 'total_expense', 'net', 'net_after']);
    for (const r of body.rows.filter((x: any) => !results.has(x.key))) {
      for (const region of ['PG', 'KL', 'EM']) {
        const sum = body.lines.filter((l: any) => l.row === r.key).reduce((x: number, l: any) => x + l.cells[region], 0);
        expect(sum, `${r.key} ${region}`).toBe(body.perMonth[0].rows[r.key][region]);
      }
    }
    expect(body.lines.filter((l: any) => l.row === 'recruitment').map((l: any) => [l.accountCode, l.text, l.cells.KL])).toEqual([['900-A004', 'WAREHOUSE ASSISTANT - AUG26', 6_000]]);
    expect(body.lines.filter((l: any) => l.row === 'income_2990').map((l: any) => [l.ref, l.party])).toEqual([['HC-ODB-2610-001', '2990 HOME SDN BHD']]);
  });
});

describe("Finance's rates", () => {
  test('the money right only; a percentage from 0 to 100; saved and read back', async () => {
    const sb = world();
    expect((await harness(sb, ['scm.access']).put({ dept: 'ga', pct: 10 })).status).toBe(403);
    const h = harness(sb);
    expect((await h.put({ dept: 'sales', pct: 10 })).body.error).toBe('bad_dept');
    expect((await h.put({ dept: 'ga', pct: 101 })).body.error).toBe('bad_pct');
    expect((await h.put({ dept: 'ga', pct: '10' })).body.error).toBe('bad_pct');
    expect((await h.put({ dept: 'ga', pct: 10 })).body).toEqual({ ok: true, dept: 'ga', bp: 1_000 });
    expect((await h.put({ dept: 'operation', pct: 6.5 })).body).toEqual({ ok: true, dept: 'operation', bp: 650 });
    expect((await h.get(`/departments/ga${SEP}`)).body.perMonth[0].shareSen).toBe(250_000);
    const op = await h.get(`/departments/operation${SEP}`);
    expect(op.body.perMonth[0].rows.do_income).toEqual({ PG: 65_000, KL: 195_000, EM: 0 });
    expect(op.body.rows.find((r: any) => r.key === 'do_income').label).toBe('6.5% Income from Delivery Order');
    /* Merchandise's rate sits with its accounts: saving it keeps them. */
    expect((await h.put({ dept: 'merchandise', pct: 2.5 })).body).toEqual({ ok: true, dept: 'merchandise', bp: 250 });
    expect((await h.get(`/departments/dept?d=exhibition${SEP_AND}`)).body.rates.merchandiseBp).toBe(250);
  });

  test("merchandise's rate keeps the accounts it stands in for", async () => {
    const sb = world({ acc_department_settings: [{ company_id: CO, plan: HOUZS_PLAN, charges: { merchandiseBp: 200, merchandise: ['900-T009'], setupDismantle: ['900-T031'] } }] });
    const h = harness(sb);
    expect((await h.put({ dept: 'merchandise', pct: 3 })).body.bp).toBe(300);
    const plan = (await h.get('/departments/plan')).body;
    expect(plan.branches.map((b: any) => b.key)).toEqual(['setupDismantle']);
    expect((await h.get(`/departments/all${SEP}`)).body.rates.merchandiseBp).toBe(300);
  });

  test('a From after the To, or more than 24 months, is refused', async () => {
    const h = harness(world());
    expect((await h.get('/departments/ga?from=2026-09-30&to=2026-09-01')).status).toBe(400);
    expect((await h.get('/departments/operation?from=2024-01-01&to=2026-09-30')).status).toBe(400);
  });
});

describe('a supplier\'s rebates, estimated in the Exhibition\'s Performance P&L (owner 2026-11-27: 「做设定框」)', () => {
  /* A made-up supplier and its made-up terms: a sponsor rebate of 12% leaving out ALPHA and
     accessories, a sales rebate of 2% / 4% / 6% from RM 80,000 / 160,000 / 240,000 on the
     purchases less the display sets, a 40% display discount. */
  const RULE = {
    supplierCode: '400-R001', label: 'REBATE CO', sponsorBp: 1200, namedWords: ['ALPHA'], accessoryWords: ['PILLOW'],
    salesTiers: [{ fromSen: 8_000_000, bp: 200 }, { fromSen: 16_000_000, bp: 400 }, { fromSen: 24_000_000, bp: 600 }], displayDiscountBp: 4000,
  };
  const pi = (id: string, invoice_date: string, status: string, over: Row = {}): Row => ({
    id, company_id: CO, supplier_id: 'sup-r', invoice_number: `PI-${id}`, invoice_date, status, ...over,
  });
  const pii = (id: string, purchase_invoice_id: string, item_code: string, material_name: string, line_total_sen: number, over: Row = {}): Row => ({
    id, company_id: CO, purchase_invoice_id, item_code, material_name, description: null, line_total_sen, ...over,
  });
  const scn = (id: string, status: string, reason: string, total_sen: number): Row => ({
    id, company_id: CO, kind: 'SCN', status, supplier_id: 'sup-r', note_number: `SCN-${id}`, note_date: '2026-09-25', total_sen, reason,
  });
  const rebates = (rules: unknown) => world({
    acc_department_settings: [{ company_id: CO, ga_share_bp: 800, operation_income_bp: 700, plan: HOUZS_PLAN, supplier_rebates: rules }],
    suppliers: [
      { id: 'sup-r', company_id: CO, code: '400-R001', name: 'REBATE CO' },
      { id: 'sup-elsewhere', company_id: 2, code: '400-R009', name: 'ANOTHER COMPANY\'S' },
    ],
    purchase_invoices: [
      pi('p1', '2026-09-05', 'POSTED'),
      pi('p2', '2026-09-20', 'CANCELLED'),
      pi('p3', '2026-09-21', 'DRAFT'),
      pi('p4', '2026-10-02', 'PAID'),
      pi('px', '2026-09-05', 'POSTED', { company_id: 2, supplier_id: 'sup-elsewhere' }),
    ],
    purchase_invoice_items: [
      pii('i1', 'p1', 'RC-MAT-K', 'RC MATTRESS K', 30_000_000),
      pii('i2', 'p1', 'RC-ALPHA-Q', 'RC ALPHA MATTRESS Q', 5_000_000),
      pii('i3', 'p1', 'RC-PIL', 'RC COOL CUSHION', 2_000_000),
      pii('i4', 'p2', 'RC-MAT-K', 'RC MATTRESS K', 9_000_000),
      pii('i5', 'p3', 'RC-MAT-K', 'RC MATTRESS K', 8_000_000),
      pii('i6', 'p4', 'RC-MAT-K', 'RC MATTRESS K', 6_000_000),
      pii('ix', 'px', 'RC-MAT-K', 'RC MATTRESS K', 7_000_000, { company_id: 2 }),
    ],
    mfg_products: [
      { company_id: CO, code: 'RC-MAT-K', category: 'MATTRESS' },
      { company_id: CO, code: 'RC-ALPHA-Q', category: 'MATTRESS' },
      { company_id: CO, code: 'RC-PIL', category: 'ACCESSORY' },
    ],
    ap_invoices: [{ id: 'a1', company_id: CO, supplier_id: 'sup-r', invoice_number: 'API-1', invoice_date: '2026-09-12', status: 'PAID' }],
    ap_invoice_lines: [
      { id: 'al1', company_id: CO, invoice_id: 'a1', description: 'RC SOFT PILLOW', amount_sen: 1_000_000 },
      { id: 'al2', company_id: CO, invoice_id: 'a1', description: 'RC MATTRESS SS', amount_sen: 4_000_000 },
    ],
    acc_credit_notes: [
      scn('n1', 'POSTED', 'DISPLAY DISCOUNT - SEP', 1_000_000),
      scn('n2', 'DRAFT', 'DISPLAY DISCOUNT - SEP', 500_000),
      scn('n3', 'POSTED', 'SALES REBATE - SEP', 3_000_000),
    ],
  });
  /* September: bills RM 420,000 (the posted invoice's RM 370,000, the AP invoice's RM 50,000; the
     cancelled, the draft, October's and another company's left out); ALPHA RM 50,000 and
     accessories RM 30,000 (the product's category, the AP line's PILLOW) off the sponsor's
     base = RM 340,000 → 12% = RM 40,800; the posted display note RM 10,000 ÷ 40% = display
     sets RM 25,000 off the sales base = RM 395,000, past RM 240,000 → 6% = RM 23,700. */
  const SPONSOR = 4_080_000;
  const SALES = 2_370_000;
  const figure = (tree: any, id: string) => nodes(tree.otherIncome).find((n: any) => n.id === id);

  test('Performance: the two estimates under the Exhibition\'s other income, and the rules it keeps; Actual and a company without rules have none', async () => {
    const h = harness(rebates([RULE]));
    const perf = await h.get(`/departments/dept?d=exhibition&dbasis=performance${SEP_AND}`);
    expect(perf.status).toBe(200);
    expect(figure(perf.body.tree, 'rebate:400-R001:sponsor')).toMatchObject({ cells: { '2026-09': SPONSOR }, label: expect.stringContaining('REBATE CO sponsor rebate (estimate)') });
    expect(figure(perf.body.tree, 'rebate:400-R001:sales')).toMatchObject({ cells: { '2026-09': SALES } });
    expect(perf.body.rebateRules).toEqual([RULE]);
    const none = await harness(world()).get(`/departments/dept?d=exhibition&dbasis=performance${SEP_AND}`);
    expect(none.body.rebateRules).toEqual([]);
    expect(perf.body.perMonth[0].otherIncomeSen - none.body.perMonth[0].otherIncomeSen).toBe(SPONSOR + SALES);
    expect(perf.body.perMonth[0].netSen - none.body.perMonth[0].netSen).toBe(SPONSOR + SALES);
    expect(figure(none.body.tree, 'rebate:400-R001:sponsor')).toBeUndefined();
    const actual = await h.get(`/departments/dept?d=exhibition&dbasis=actual${SEP_AND}`);
    expect(figure(actual.body.tree, 'rebate:400-R001:sponsor')).toBeUndefined();
    expect(figure(actual.body.tree, 'rebate:400-R001:sales')).toBeUndefined();
  });

  test('All: the Exhibition\'s column carries them; the other departments do not', async () => {
    const withRules = await harness(rebates([RULE])).get(`/departments/all?dbasis=performance${SEP_AND}`);
    const without = await harness(world()).get(`/departments/all?dbasis=performance${SEP_AND}`);
    expect(withRules.status).toBe(200);
    expect(withRules.body.summary.exhibition.otherIncomeSen - without.body.summary.exhibition.otherIncomeSen).toBe(SPONSOR + SALES);
    expect(withRules.body.summary.ga).toEqual(without.body.summary.ga);
    expect(withRules.body.total.profitSen - without.body.total.profitSen).toBe(SPONSOR + SALES);
  });

  test('a figure opened: its working, month by month, adding up to it', async () => {
    const h = harness(rebates([RULE]));
    const r = await h.get(`/departments/lines?view=dept&dbasis=performance&block=otherIncome&d=exhibition${SEP_AND}&keys=rebate:400-R001:sponsor,rebate:400-R001:sales`);
    expect(r.status).toBe(200);
    expect(r.body.totalSen).toBe(SPONSOR + SALES);
    expect(r.body.lines.map((l: any) => [l.id, l.accountCode, l.accountName, l.source, l.sen])).toEqual([
      ['rebate:400-R001:sales:2026-09', '400-R001', 'REBATE CO sales rebate (estimate)', 'rate', SALES],
      ['rebate:400-R001:sponsor:2026-09', '400-R001', 'REBATE CO sponsor rebate (estimate)', 'rate', SPONSOR],
    ]);
    const sponsor = r.body.lines.find((l: any) => l.id === 'rebate:400-R001:sponsor:2026-09');
    expect(sponsor.text).toBe("12% of RM 340,000.00: the month's REBATE CO bills RM 420,000.00, less ALPHA RM 50,000.00 and accessories RM 30,000.00");
    const one = await h.get(`/departments/lines?view=dept&dbasis=performance&block=otherIncome&d=exhibition${SEP_AND}&keys=rebate:400-R001:sales`);
    expect(one.body.totalSen).toBe(SALES);
  });

  test('PUT /departments/rebates: Finance\'s right; checked; a supplier must be the company\'s; the list saved whole and read back', async () => {
    const sb = rebates(null);
    expect((await harness(sb, ['scm.access']).putAt('/departments/rebates', { rules: [RULE] })).status).toBe(403);
    const h = harness(sb);
    const bad = await h.putAt('/departments/rebates', { rules: [{ ...RULE, sponsorBp: 0, salesTiers: [] }] });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe('400-R001 earns nothing — give a sponsor rebate rate or a sales rebate tier.');
    const elsewhere = await h.putAt('/departments/rebates', { rules: [{ ...RULE, supplierCode: '400-R009' }] });
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.body.error).toBe('unknown_supplier');
    const ok = await h.putAt('/departments/rebates', { rules: [{ ...RULE, supplierCode: '400-r001' }] });
    expect(ok.status).toBe(200);
    expect(sb.tables.acc_department_settings[0]!.supplier_rebates).toEqual([RULE]);
    const read = await h.get(`/departments/dept?d=exhibition&dbasis=performance${SEP_AND}`);
    expect(read.body.rebateRules).toEqual([RULE]);
    expect(figure(read.body.tree, 'rebate:400-R001:sponsor').cells).toEqual({ '2026-09': SPONSOR });
    expect((await h.putAt('/departments/rebates', { rules: [] })).status).toBe(200);
    expect(sb.tables.acc_department_settings[0]!.supplier_rebates).toBeNull();
  });
});
