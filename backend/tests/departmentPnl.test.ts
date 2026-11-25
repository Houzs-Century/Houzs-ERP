/* The Department P&L through its handlers, over the fake-PostgREST harness (owner
   2026-11-19: an Operation report = his "Operation PNL - Auto" sheet, a G&A report,
   and 「我要可以看全部的，也要可以看单独部门的」). The arithmetic is
   scm/lib/department-pnl.test.ts; pinned here, with made-up figures:
     • All (owner 2026-11-25): every department's own P&L side by side, each column its
       own view's figures — the Exhibition on its orders, Operation to its Net Profit,
       Logistics by the Logistics P&L, G&A against its share — and their total;
     • the Exhibition on its orders: the Performance P&L's sales and cost, its own
       expenses, the commission bills in place of the release;
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
  departmentLinesHandler, departmentViewHandler, departmentsAllHandler, departmentsGaHandler, departmentsOperationHandler, departmentsPlanHandler, saveDepartmentRateHandler,
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
  app.get('/departments/lines', departmentLinesHandler as never);
  app.get('/logistics/pnl', logisticsPnlHandler as never);
  app.put('/departments/rate', saveDepartmentRateHandler as never);
  const get = async (path: string) => { const r = await app.request(path); return { status: r.status, body: await r.json() as any }; };
  const put = async (body: unknown) => {
    const r = await app.request('/departments/rate', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    return { status: r.status, body: await r.json() as any };
  };
  return { get, put };
}
const SEP = '?from=2026-09-01&to=2026-09-30';

const SEP_AND = SEP.replace('?', '&');
const nodes = (ns: any[]): any[] => ns.flatMap((n: any) => [n, ...nodes(n.children ?? [])]);
const leaf = (ns: any[], code: string): any => nodes(ns).find((n: any) => n.kind === 'account' && n.code === code);

describe("GET /departments/all — every department's own P&L, side by side (owner 2026-11-25)", () => {
  test("each column is its own view's figures: the Exhibition on its orders, Operation to its Net Profit, Logistics by its P&L, G&A against its share", async () => {
    const h = harness(world());
    const { status, body } = await h.get(`/departments/all${SEP}`);
    expect(status).toBe(200);
    expect(body.departments.map((x: any) => [x.key, x.view, x.basis])).toEqual([
      ['exhibition', 'dept', 'orders'], ['operation', 'operation', null], ['logistics', 'logistics', null], ['ga', 'ga', null],
    ]);
    /* The Exhibition: the order's sales and cost — not the books' 5,000,000 of sales — less what it booked. */
    expect(body.summary.exhibition).toEqual({ incomeSen: 2_500_000, costSen: 1_000_000, grossSen: 1_500_000, otherIncomeSen: 0, expensesSen: 420_000, profitSen: 1_080_000 });
    const own = (await h.get(`/departments/dept?d=exhibition${SEP_AND}`)).body.perMonth[0];
    expect(body.summary.exhibition.profitSen).toBe(own.netSen);
    /* Operation: its income less the Logistic Expense and the warehouse — its Net Profit, not the net after Logistics. */
    const op = (await h.get(`/departments/operation${SEP}`)).body;
    const t = (k: string) => Object.values(op.perMonth[0].rows[k] as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(body.summary.operation).toEqual({
      incomeSen: t('do_income') + t('income_warehouse') + t('income_2990') + t('income_other'), costSen: -t('logistic_expense'),
      grossSen: t('gross'), otherIncomeSen: 0, expensesSen: t('total_expense'), profitSen: t('net'),
    });
    expect(body.summary.operation.profitSen).toBe(350_000 - 120_000 - 576_000);
    /* Logistics: the Logistics P&L's own totals. */
    const lg = (await h.get(`/logistics/pnl${SEP}`)).body;
    const row = (k: string) => lg.rows.find((r: any) => r.key === k).totalSen;
    expect(body.summary.logistics).toEqual({
      incomeSen: row('total_income'), costSen: 0, grossSen: row('total_income'), otherIncomeSen: 0, expensesSen: row('total_expense'), profitSen: row('net'),
    });
    /* G&A: 8% of the Performance sales against what it booked. */
    expect(body.summary.ga).toEqual({ incomeSen: 200_000, costSen: 0, grossSen: 200_000, otherIncomeSen: 0, expensesSen: 507_500, profitSen: -307_500 });
    expect(body.gaShareBp).toBe(800);
    /* The total is the departments added up. */
    for (const k of ['incomeSen', 'costSen', 'grossSen', 'otherIncomeSen', 'expensesSen', 'profitSen']) {
      expect(body.total[k], k).toBe(['exhibition', 'operation', 'logistics', 'ga'].reduce((a, d) => a + body.summary[d][k], 0));
    }
    /* An expense account with no department is named. */
    expect(body.unassigned).toEqual({ label: 'No department yet', lines: [{ code: '900-U014', name: '900-U014', amountSen: 20_000 }] });
  });

  test("a shop's departments: the Showroom as booked, G&A against its share", async () => {
    const shop = world({ acc_department_settings: [{ company_id: CO, ga_share_bp: 800, plan: { departments: ['showroom', 'ga'], selling: 'showroom', folds: { exhibition: 'showroom', operation: 'showroom', logistics: 'showroom' } } }] });
    const h = harness(shop);
    const { body } = await h.get(`/departments/all${SEP}`);
    expect(body.departments.map((x: any) => [x.key, x.view, x.basis])).toEqual([['showroom', 'dept', 'books'], ['ga', 'ga', null]]);
    const own = (await h.get(`/departments/dept?d=showroom${SEP_AND}`)).body.perMonth[0];
    expect(body.summary.showroom).toMatchObject({ incomeSen: 5_000_000, profitSen: own.netSen });
    expect(Object.keys(body.summary)).toEqual(['showroom', 'ga']);
  });

  test("the statements' right only", async () => {
    expect((await harness(world(), ['scm.access']).get(`/departments/all${SEP}`)).status).toBe(403);
  });
});

describe('GET /departments/plan and /departments/dept — the company\'s departments, one at a time', () => {
  test("the Exhibition P&L on its orders: the Performance P&L's sales and cost, less what Exhibition booked, month by month", async () => {
    const h = harness(world());
    const plan = await h.get('/departments/plan');
    expect(plan.body.departments.map((x: any) => x.label)).toEqual(['Exhibition', 'Operation', 'Logistics', 'G&A']);
    const { status, body } = await h.get(`/departments/dept?d=exhibition&from=2026-09-01&to=2026-09-30`);
    expect(status).toBe(200);
    expect(body.label).toBe('Exhibition');
    expect(body.basis).toBe('orders');
    expect(body.orders).toEqual({ counted: 1, notDelivered: 1 });
    expect(body.perMonth).toEqual([{
      month: '2026-09', salesSen: 2_500_000, costOfSalesSen: 1_000_000, grossSen: 1_500_000, otherIncomeSen: 0,
      expensesSen: 400_000 + 20_000, taxationSen: 0, netSen: 1_500_000 - 420_000,
    }]);
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
    const dept = (await h.get(`/departments/dept?d=showroom${both}`)).body;
    expect(dept.basis).toBe('books');
    let checked = 0;
    for (const block of BLOCKS) {
      for (const n of nodes(dept.tree[block])) {
        for (const m of [...months, null]) {
          const res = await h.get(`/departments/lines?view=dept&d=showroom&block=${block}&keys=${keysOf(n)}${range(m)}`);
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
    const stock = await h.get(`/departments/lines?view=dept&d=showroom&block=costOfSales&keys=600-0001${SEP.replace('?', '&')}`);
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

describe("Finance's two rates", () => {
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
  });

  test('a From after the To, or more than 24 months, is refused', async () => {
    const h = harness(world());
    expect((await h.get('/departments/ga?from=2026-09-30&to=2026-09-01')).status).toBe(400);
    expect((await h.get('/departments/operation?from=2024-01-01&to=2026-09-30')).status).toBe(400);
  });
});
