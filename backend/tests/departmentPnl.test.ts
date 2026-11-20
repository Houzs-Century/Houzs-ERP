/* The Department P&L through its handlers, over the fake-PostgREST harness (owner
   2026-11-19: an Operation report = his "Operation PNL - Auto" sheet, a G&A report,
   and 「我要可以看全部的，也要可以看单独部门的」). The arithmetic is
   scm/lib/department-pnl.test.ts; pinned here, with made-up figures:
     • All: every P&L line split across the departments, each block's columns adding
       up to the P&L's own total, a reversed pair counting nowhere;
     • Operation: the DOs by region, 7% of their value, the Logistics P&L's own 3% as
       the logistic expense, the OPERATION CHARGES bill in the month it names, the
       warehouse accounts and the warehouse teams' payroll lines;
     • G&A: its share of the Performance sales and what the HQ teams and the G&A
       accounts booked;
     • the two rates: Finance's right only, checked, saved and read back;
     • a figure opened (owner 2026-11-20: 「我希望这里点开也能看」): the lines behind every
       figure of All, the Exhibition P&L and G&A add up to it, the stock engine's
       opening stock in place of the ledger's own, nothing of another company's;
       the Operation sheet's rows are its lines added up. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import {
  departmentLinesHandler, departmentViewHandler, departmentsAllHandler, departmentsGaHandler, departmentsOperationHandler, departmentsPlanHandler, saveDepartmentRateHandler,
} from '../src/scm/routes/acc-departments';

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
  app.put('/departments/rate', saveDepartmentRateHandler as never);
  const get = async (path: string) => { const r = await app.request(path); return { status: r.status, body: await r.json() as any }; };
  const put = async (body: unknown) => {
    const r = await app.request('/departments/rate', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    return { status: r.status, body: await r.json() as any };
  };
  return { get, put };
}
const SEP = '?from=2026-09-01&to=2026-09-30';

describe('GET /departments/all — the whole P&L by department', () => {
  test("every line split across the company's departments, each block's columns adding up to the P&L's own total", async () => {
    const { status, body } = await harness(world()).get(`/departments/all${SEP}`);
    expect(status).toBe(200);
    expect(body.columns.map((x: any) => x.key)).toEqual(['exhibition', 'operation', 'logistics', 'ga']);
    expect(body.departments.map((x: any) => [x.key, x.view])).toEqual([['exhibition', 'dept'], ['operation', 'operation'], ['logistics', null], ['ga', 'ga']]);
    const leaf = (block: string, code: string): any => {
      const walk = (ns: any[]): any[] => ns.flatMap((n: any) => (n.code === code && n.kind === 'account' ? [n] : walk(n.children ?? [])));
      return walk(body.tree[block])[0];
    };
    /* Finance's team G&A, helpers Logistics, the warehouse teams Operation, the line naming no team the selling department. */
    expect(leaf('expenses', '900-S100').cells).toEqual({ exhibition: 20_000, operation: 120_000, logistics: 50_000, ga: 80_000, none: 0 });
    expect(leaf('expenses', '900-D100').cells.ga).toBe(200_000);
    expect(leaf('expenses', '900-R005').cells.operation).toBe(270_000);
    expect(leaf('expenses', '900-T005').cells.logistics).toBe(150_000);
    expect(leaf('expenses', '900-B003').cells.exhibition).toBe(400_000);
    /* Houzs's showroom folds into G&A; a warehouse job ad is Operation's, an account executive's G&A's. */
    expect(leaf('expenses', '900-R009').cells.ga).toBe(220_000);
    expect(leaf('expenses', '900-A004').cells).toEqual({ exhibition: 0, operation: 6_000, logistics: 0, ga: 2_500, none: 0 });
    expect(leaf('otherIncome', '599-0000').cells).toEqual({ exhibition: 0, operation: 70_000, logistics: 40_000, ga: 1_000, none: 0 });
    expect(leaf('tradingIncome', '501-0000').cells.exhibition).toBe(5_000_000);
    for (const [block, key] of [['expenses', 'expensesSen'], ['otherIncome', 'otherIncomeSen'], ['tradingIncome', 'tradingIncomeSen']] as const) {
      const t = body.blockTotals[block];
      expect(t.exhibition + t.operation + t.logistics + t.ga + t.none).toBe(body.totals[key]);
    }
    /* An expense account with no department is named, never a column. */
    expect(body.unassigned).toEqual({ label: 'No department yet', lines: [{ code: '900-U014', name: '900-U014', amountSen: 20_000 }] });
  });

  test("the statements' right only", async () => {
    expect((await harness(world(), ['scm.access']).get(`/departments/all${SEP}`)).status).toBe(403);
  });
});

describe('GET /departments/plan and /departments/dept — the company\'s departments, one at a time', () => {
  test('the Exhibition P&L: the fairs\' sales less what Exhibition booked, month by month', async () => {
    const h = harness(world());
    const plan = await h.get('/departments/plan');
    expect(plan.body.departments.map((x: any) => x.label)).toEqual(['Exhibition', 'Operation', 'Logistics', 'G&A']);
    const { status, body } = await h.get(`/departments/dept?d=exhibition&from=2026-09-01&to=2026-09-30`);
    expect(status).toBe(200);
    expect(body.label).toBe('Exhibition');
    expect(body.perMonth).toEqual([{
      month: '2026-09', salesSen: 5_000_000, costOfSalesSen: 0, grossSen: 5_000_000, otherIncomeSen: 0,
      expensesSen: 400_000 + 20_000, taxationSen: 0, netSen: 5_000_000 - 420_000,
    }]);
    expect((await h.get(`/departments/dept?d=showroom${SEP.replace('?', '&')}`)).body.error).toBe('bad_department');
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
  const nodes = (ns: any[]): any[] => ns.flatMap((n: any) => [n, ...nodes(n.children ?? [])]);
  const leaves = (n: any): string[] => (n.kind === 'account' ? [n.key ?? n.code] : (n.children ?? []).flatMap(leaves));
  const keysOf = (n: any) => encodeURIComponent(leaves(n).join(','));
  /* Houzs's books start on 1 September with opening stock; the ledger's own stock line is the P&L's to set aside. */
  const booked = () => world({
    acc_company_settings: [{ company_id: CO, books_start_date: '2026-09-01', opening_stock: { customer: 300_000 } }],
    v_gl_entries: [
      ...LEDGER.map((r) => ({ ...r })),
      gl('600-0001', 77_777, 0, { entry_date: '2026-09-30', notes: 'MONTH CLOSE' }),
      gl('900-P001', 123_456, 0, { company_id: 2, line_id: 'other-co' }),
      gl('900-P001', 1_500, 0, { entry_date: '2026-10-12' }),
      gl('900-S100', 60_000, 0, { notes: "IT SALARY - OCT'26", entry_date: '2026-10-31' }),
    ],
  });

  test('All: every account, category and block, in every department and the Total', async () => {
    const h = harness(booked());
    const all = (await h.get(`/departments/all${SEP}`)).body;
    let checked = 0;
    for (const block of BLOCKS) {
      for (const n of nodes(all.tree[block])) {
        for (const col of [...all.columns.map((x: any) => x.key), 'none', null]) {
          const res = await h.get(`/departments/lines?view=all&block=${block}&keys=${keysOf(n)}${col ? `&dept=${col}` : ''}&from=2026-09-01&to=2026-09-30`);
          expect(res.status).toBe(200);
          const cell = col ? (n.cells?.[col] ?? 0) : n.amountSen;
          expect(res.body.totalSen, `${block} ${n.id} ${col ?? 'Total'}`).toBe(cell);
          expect(res.body.lines.reduce((x: number, l: any) => x + l.sen, 0)).toBe(cell);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(40);
    /* The payroll account's G&A figure: Finance's team line, nothing else. */
    const pay = await h.get(`/departments/lines?view=all&block=expenses&keys=900-S100&dept=ga${SEP.replace('?', '&')}`);
    expect(pay.body.lines.map((l: any) => [l.text, l.sen, l.dept])).toEqual([["FINANCE - SALARY - SEP'26", 80_000, 'ga']]);
    /* Opening stock is the books' own, not the ledger's month-close line on the same account. */
    const stock = await h.get(`/departments/lines?view=all&block=costOfSales&keys=600-0001${SEP.replace('?', '&')}`);
    expect(stock.body.lines.map((l: any) => [l.source, l.sen, l.dept])).toEqual([['stock_opening', 300_000, 'exhibition']]);
  });

  test("the Exhibition P&L and G&A: each month's figure and the Total, row by row", async () => {
    const h = harness(booked());
    const both = '&from=2026-09-01&to=2026-10-31';
    const months = ['2026-09', '2026-10'];
    const range = (m: string | null) => (m ? `&from=${m}-01&to=${m === '2026-09' ? '2026-09-30' : '2026-10-31'}` : both);
    const dept = (await h.get(`/departments/dept?d=exhibition${both}`)).body;
    for (const block of BLOCKS) {
      for (const n of nodes(dept.tree[block])) {
        for (const m of [...months, null]) {
          const res = await h.get(`/departments/lines?view=dept&d=exhibition&block=${block}&keys=${keysOf(n)}${range(m)}`);
          const cell = m ? (n.cells?.[m] ?? 0) : months.reduce((x, k) => x + (n.cells?.[k] ?? 0), 0);
          expect(res.body.totalSen, `${block} ${n.id} ${m ?? 'Total'}`).toBe(cell);
        }
      }
    }
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
    const all = await h.get(`/departments/lines?view=all&block=expenses&keys=900-P001${SEP.replace('?', '&')}`);
    expect(all.body.totalSen).toBe(5_000);
  });

  test('the statements\' right only; a view, a block, a department and accounts that make sense', async () => {
    expect((await harness(world(), ['scm.access']).get(`/departments/lines?view=ga&keys=900-P001${SEP.replace('?', '&')}`)).status).toBe(403);
    const h = harness(world());
    const q = SEP.replace('?', '&');
    expect((await h.get(`/departments/lines?view=operation&keys=900-P001${q}`)).body.error).toBe('bad_view');
    expect((await h.get(`/departments/lines?view=ga${q}`)).body.error).toBe('bad_keys');
    expect((await h.get(`/departments/lines?view=all&block=assets&keys=900-P001${q}`)).body.error).toBe('bad_block');
    expect((await h.get(`/departments/lines?view=all&block=expenses&dept=showroom&keys=900-P001${q}`)).body.error).toBe('bad_department');
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
