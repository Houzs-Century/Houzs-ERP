/* The Department P&L's arithmetic (owner 2026-11-19). Figures are made up; the
   words are the books' own (the salary journal's team lines, the Other Debtor
   recharges, the warehouse accounts).
     • All: a P&L line split across the departments always adds up to the line;
     • Operation: the owner's "Operation PNL - Auto" sheet by region — 7% of the DO
       value, the recharges in the month they name, (-) the Logistics P&L's own
       Transport Income, the warehouse rows, manpower by team line (a region named,
       else shared by the DO value), insurance spread over 12 months, then the
       Logistics and Setup/Dismantle results and the net after both;
     • G&A: its share of the sales against what the HQ teams and the G&A accounts
       booked, on the P&L's own tree;
     • the selling department (owner 2026-11-25): what it pays the others, the fair
       transport leaving it, in Performance merchandise in place of the terminal charges;
     • the lines a figure opens (owner 2026-11-20: 「我希望这里点开也能看」): a P&L
       line's parts, the Operation sheet's lines, G&A's legs — each adding up to its figure. */

import { describe, expect, test } from 'vitest';
import {
  addSummaries, bookedByAccount, bookedSalesExService, buildDeptView, buildGaPnl, buildOperationPnl, gaLines, operationRows, opSum, shareByValue,
  splitLine, splitLineParts, summaryOfDept, summaryOfGa, summaryOfUnit, unassignedOf,
  type DeptCharges, type GaPnl, type LogisticsMonthIn, type OrdersMonthIn,
} from './department-pnl';
import { chargesOf } from './department-charges';
import { buildLogisticsUnit, buildOperationUnit } from './department-units';
import { parsePlan, type DeptAccount } from './department-rows';
import type { BillLine, Leg } from './logistics-pnl';
import type { LayoutItem } from '../../acc/report-layout';

const acc = (account_code: string, account_name: string, extra: Partial<DeptAccount> = {}): DeptAccount =>
  ({ account_code, account_name, account_type: 'EXPENSE', is_active: true, logistics_row: null, department_row: null, ...extra });
let seq = 0;
const leg = (accountCode: string, day: string, debitSen: number, notes: string | null = null, creditSen = 0): Leg =>
  ({ lineId: `l${++seq}`, accountCode, accountName: null, day, debitSen, creditSen, notes, docNo: `JE-${seq}` });

const HOUZS = parsePlan({ departments: ['exhibition', 'operation', 'logistics', 'ga'], selling: 'exhibition', folds: { showroom: 'ga' } });
const SHOP = parsePlan({ departments: ['showroom', 'ga'], selling: 'showroom', folds: { exhibition: 'showroom', operation: 'showroom', logistics: 'showroom' } });

describe('All: one P&L line across the company\'s departments', () => {
  const staff = acc('900-S100', 'STAFF SALARIES & OVERTIME');
  const payLegs = [
    { accountCode: '900-S100', notes: 'FINANCE - SALARY - OCT2026', debitSen: 3_000, creditSen: 0 },
    { accountCode: '900-S100', notes: "OPERATION HELPER SALARY - OCT'26", debitSen: 2_000, creditSen: 0 },
    { accountCode: '900-S100', notes: "WAREHOUSE OPERATIONS SALARY - OCT'26", debitSen: 4_000, creditSen: 0 },
    { accountCode: '900-S100', notes: "GROSS SALARY - OCT'26", debitSen: 500, creditSen: 0 },
  ];
  test('a payroll account splits by its team lines; a line naming none is the selling department\'s; the cells add up', () => {
    const cells = splitLine({ amountSen: 9_500, sign: 1, account: staff, payroll: true, recharge: false, mixed: true, fallback: 'none', plan: HOUZS, legs: payLegs });
    expect(cells).toEqual({ exhibition: 500, operation: 4_000, logistics: 2_000, ga: 3_000, none: 0 });
    expect(Object.values(cells).reduce((a, b) => a! + b!, 0)).toBe(9_500);
    /* What the legs do not explain stays with the account — an account with no department says so. */
    expect(splitLine({ amountSen: 9_600, sign: 1, account: staff, payroll: true, recharge: false, mixed: true, fallback: 'none', plan: HOUZS, legs: payLegs }).none).toBe(100);
  });

  test('its parts are its legs, each in its department, adding up to the line — itemized or not', () => {
    const legs = payLegs.map((l, i) => ({ ...l, lineId: `p${i}` }));
    const parts = splitLineParts({ amountSen: 9_500, sign: 1, account: staff, payroll: true, recharge: false, mixed: true, fallback: 'none', plan: HOUZS, legs, itemize: false });
    expect(parts.map((x) => [x.leg?.lineId, x.dept, x.sen])).toEqual([['p0', 'ga', 3_000], ['p1', 'logistics', 2_000], ['p2', 'operation', 4_000], ['p3', 'exhibition', 500]]);
    /* An account read whole: unitemized one part; itemized its legs, the same department, the same sum. */
    const print = acc('900-P001', 'PRINTING & STATIONERY', { department_row: 'ga' });
    const own = [{ lineId: 'q1', accountCode: '900-P001', notes: null, debitSen: 700, creditSen: 0 }, { lineId: 'q2', accountCode: '900-P001', notes: null, debitSen: 0, creditSen: 200 }];
    const whole = { amountSen: 500, sign: 1 as const, account: print, payroll: false, recharge: false, mixed: false, fallback: 'none' as const, plan: HOUZS, legs: own };
    expect(splitLineParts({ ...whole, itemize: false }).map((x) => [x.leg, x.dept, x.sen])).toEqual([[null, 'ga', 500]]);
    expect(splitLineParts({ ...whole, itemize: true }).map((x) => [x.leg?.lineId, x.dept, x.sen])).toEqual([['q1', 'ga', 700], ['q2', 'ga', -200]]);
    /* What the legs do not explain (a stock line, read whole): one part, in the account's own department. */
    expect(splitLineParts({ ...whole, legs: undefined, itemize: true }).map((x) => [x.leg, x.dept, x.sen])).toEqual([[null, 'ga', 500]]);
  });

  test("2990's plan: its operation and logistics count in Showroom, its office in G&A", () => {
    expect(splitLine({ amountSen: 9_500, sign: 1, account: staff, payroll: true, recharge: false, mixed: true, fallback: 'none', plan: SHOP, legs: payLegs }))
      .toEqual({ showroom: 6_500, ga: 3_000, none: 0 });
  });

  test('an income line reads credit-positive: recharges by their words, the rest G&A; sales are the selling department\'s', () => {
    const inc = acc('599-0000', 'ADDITIONAL INCOME', { account_type: 'INCOME' });
    expect(splitLine({
      amountSen: 1_500, sign: -1, account: inc, payroll: false, recharge: true, mixed: false, fallback: 'ga', plan: HOUZS,
      legs: [
        { accountCode: '599-0000', notes: "OPERATION CHARGES - SEP'26", debitSen: 0, creditSen: 1_000 },
        { accountCode: '599-0000', notes: "LOGISTICS CHARGES - SEP'26", debitSen: 0, creditSen: 600 },
        { accountCode: '599-0000', notes: 'SUNDRY', debitSen: 100, creditSen: 0 },
      ],
    })).toEqual({ exhibition: 0, operation: 1_000, logistics: 600, ga: -100, none: 0 });
    expect(splitLine({ amountSen: 50_000, sign: -1, account: acc('500-0001', 'SALES OF BEDDING', { account_type: 'INCOME' }), payroll: false, recharge: false, mixed: false, fallback: 'sales', plan: HOUZS, legs: undefined }))
      .toEqual({ exhibition: 50_000, operation: 0, logistics: 0, ga: 0, none: 0 });
  });

  test("an account goes whole to its department, the plan folding it; an expense account with none says so", () => {
    const one = (account: DeptAccount, plan = HOUZS) => splitLine({ amountSen: 777, sign: 1, account, payroll: false, recharge: false, mixed: false, fallback: 'none', plan, legs: undefined });
    expect(one(acc('900-R004', 'WAREHOUSE - (PENANG)', { department_row: 'op_rental_pg' })).operation).toBe(777);
    expect(one(acc('900-R009', 'SHOW ROOM (KELANA JAYA)', { department_row: 'showroom' })).ga).toBe(777);
    expect(one(acc('900-R048', 'RENTAL OF SHOWROOM - 2990S', { department_row: 'showroom' }), SHOP).showroom).toBe(777);
    expect(one(acc('900-U014', 'UPKEEP OF LORI - VRH 9058')).none).toBe(777);
  });
});

describe('a month amount shared by the DO value', () => {
  test('in whole sen, the remainder to the largest shares; no DO keeps it in KL', () => {
    expect(shareByValue(1_000, { PG: 1, KL: 3, EM: 0 })).toEqual({ PG: 250, KL: 750, EM: 0 });
    expect(shareByValue(100, { PG: 1, KL: 1, EM: 1 })).toEqual({ PG: 34, KL: 33, EM: 33 });
    expect(shareByValue(-100, { PG: 1, KL: 1, EM: 1 })).toEqual({ PG: -34, KL: -33, EM: -33 });
    expect(shareByValue(500, { PG: 0, KL: 0, EM: 0 })).toEqual({ PG: 0, KL: 500, EM: 0 });
  });
});

describe("Operation: the owner's sheet by region", () => {
  const chart = new Map<string, DeptAccount>([
    ['900-S100', acc('900-S100', 'STAFF SALARIES & OVERTIME')],
    ['900-R004', acc('900-R004', 'WAREHOUSE - (PENANG)', { department_row: 'op_rental_pg' })],
    ['900-R005', acc('900-R005', 'WAREHOUSE - (BELAKONG)', { department_row: 'op_rental_kl' })],
    ['900-R046', acc('900-R046', 'WAREHOUSE - (SABAH/SARAWAK) OUTSOURCE', { department_row: 'op_rental_em' })],
    ['900-W007', acc('900-W007', 'WATER & ELECTRICITY - WH BALAKONG', { department_row: 'op_utilities_kl' })],
    ['900-X001', acc('900-X001', 'INSURANCE WAREHOUSE', { department_row: 'op_insurance_kl' })],
    ['900-P001', acc('900-P001', 'PRINTING & STATIONERY', { department_row: 'ga' })],
  ]);
  const payroll = new Set(['900-S100']);
  /* September: DOs PG 2,000 · KL 5,000 · SG 1,000 (KL's column carries SG) · EM 2,000. */
  const sep: LogisticsMonthIn = {
    doValue: { PG: 200_000, KL: 500_000, EM: 200_000, SG: 100_000 },
    doCount: { PG: 2, KL: 5, EM: 2, SG: 1 },
    transportIncome: { PG: 6_000, KL: 15_000, EM: 6_000, SG: 3_000 },
    fairIncome: { PG: 1_000, KL: 2_000, EM: 0, SG: 0 },
    net: { PG: 4_000, KL: -1_000, EM: 500, SG: 300 },
    fairs: [
      { id: 11, code: 'EV-PG-01', name: 'PENANG HOME FAIR', venue: 'SPICE ARENA', region: 'PG', incomeSen: 1_000, costSen: 400 },
      { id: 12, code: 'EV-KL-01', name: 'KL HOME FAIR', venue: 'MITEC', region: 'KL', incomeSen: 2_000, costSen: 2_600 },
    ],
  };
  const bills: BillLine[] = [
    { lineId: 'b1', billNo: 'HC-ODB-2610-001', billDate: '2026-10-23', debtorName: '2990 HOME SDN BHD', description: "OPERATION CHARGES - SEP'26", accountCode: '599-0000', accountName: null, amountSen: 7_000 },
    { lineId: 'b2', billNo: 'HC-ODB-2610-001', billDate: '2026-10-23', debtorName: '2990 HOME SDN BHD', description: "LOGISTICS CHARGES - SEP'26", accountCode: '599-0000', accountName: null, amountSen: 4_000 },
    { lineId: 'b3', billNo: 'HC-ODB-2609-009', billDate: '2026-09-30', debtorName: 'SOME TENANT', description: "WAREHOUSE CHARGES - SEP'26", accountCode: '599-0000', accountName: null, amountSen: 5_000 },
    { lineId: 'b4', billNo: 'HC-ODB-2610-002', billDate: '2026-10-05', debtorName: '2990 HOME SDN BHD', description: "OPERATION CHARGES - OCT'26", accountCode: '599-0000', accountName: null, amountSen: 9_999 },
  ];
  const insurance = leg('900-X001', '2026-08-15', 12_000);
  const legs: Leg[] = [
    leg('900-R004', '2026-09-07', 18_000), leg('900-R005', '2026-09-07', 27_000), leg('900-R046', '2026-09-24', 800),
    leg('900-W007', '2026-09-09', 1_700),
    leg('900-S100', '2026-09-30', 9_000, "WAREHOUSE OPERATIONS SALARY - SEPT'26"),
    leg('900-S100', '2026-09-30', 3_000, "OPERATION STOREKEEPER PG SALARY - SEPT'26"),
    leg('900-S100', '2026-09-30', 5_000, "OPERATION HELPER SALARY - SEPT'26"),
    leg('900-S100', '2026-09-30', 8_000, "FINANCE - SALARY - SEP'26"),
    leg('900-P001', '2026-09-10', 300),
    insurance,
  ];
  const p = buildOperationPnl({
    months: ['2026-09'], incomeBp: 700, logistics: new Map([['2026-09', sep]]), bills, legs, chart, payroll, spreadMonths: new Map(),
  });
  const row = (key: Parameters<typeof opSum>[1]) => p.perMonth[0]!.rows[key];

  test('the DO value by region, KL carrying Singapore, and 7% of it as income', () => {
    expect(row('do_value')).toEqual({ PG: 200_000, KL: 600_000, EM: 200_000 });
    expect(row('do_income')).toEqual({ PG: 14_000, KL: 42_000, EM: 14_000 });
    expect(p.perMonth[0]!.dos).toEqual({ PG: 2, KL: 6, EM: 2 });
  });

  test('the recharges in the month they name; a transport recharge is not Operation\'s', () => {
    expect(row('income_2990')).toEqual({ PG: 0, KL: 7_000, EM: 0 });
    expect(row('income_warehouse')).toEqual({ PG: 0, KL: 5_000, EM: 0 });
    expect(row('income_other')).toEqual({ PG: 0, KL: 0, EM: 0 });
    expect(p.income.map((l) => l.lineId)).toEqual(['b3', 'b1']);
  });

  test("(-) Logistic Expense is the Logistics P&L's own Transport Income", () => {
    expect(row('logistic_expense')).toEqual({ PG: -6_000, KL: -18_000, EM: -6_000 });
    expect(row('gross')).toEqual({ PG: 8_000, KL: 36_000, EM: 8_000 });
  });

  test('the warehouse rows: each account in its region; manpower by team line', () => {
    expect(row('rental')).toEqual({ PG: 18_000, KL: 27_000, EM: 800 });
    expect(row('utilities')).toEqual({ PG: 0, KL: 1_700, EM: 0 });
    /* No region named: shared by the DO value 2 : 6 : 2. */
    expect(row('manpower_operation')).toEqual({ PG: 1_800, KL: 5_400, EM: 1_800 });
    expect(row('manpower_storekeeper')).toEqual({ PG: 3_000, KL: 0, EM: 0 });
    /* Drivers are Logistics', Finance is G&A's: neither is here. */
    expect(p.manpower.map((l) => l.row)).toEqual(['manpower_operation', 'manpower_storekeeper']);
  });

  test('insurance spread over 12 months from its bill month', () => {
    expect(row('insurance')).toEqual({ PG: 0, KL: 1_000, EM: 0 });
    expect(p.spreads).toEqual([expect.objectContaining({ lineId: insurance.lineId, kind: 'insurance', months: 12, isDefault: true, perMonthSen: 1_000, inRangeSen: 1_000, lastMonth: '2027-07' })]);
    const own = buildOperationPnl({
      months: ['2026-09'], incomeBp: 700, logistics: new Map([['2026-09', sep]]), bills: [], legs: [insurance], chart, payroll, spreadMonths: new Map([[insurance.lineId, 2]]),
    });
    expect(own.perMonth[0]!.rows.insurance.KL).toBe(6_000);
  });

  test('every row but the results is its lines added up, month by month and region by region', () => {
    const results = new Set(['gross', 'total_expense', 'net', 'net_after']);
    for (const r of operationRows(700).filter((x) => !results.has(x.key))) {
      for (const region of ['PG', 'KL', 'EM'] as const) {
        const sum = p.lines.filter((l) => l.row === r.key && l.month === '2026-09').reduce((x, l) => x + l.cells[region], 0);
        expect(sum, `${r.key} ${region}`).toBe(row(r.key)[region]);
      }
    }
    expect(new Set(p.lines.map((l) => l.id)).size).toBe(p.lines.length);
  });

  test('a line says what it is: the ledger line, the bill, the fair, or the Logistics figure and how it was worked out', () => {
    const of = (rowKey: string) => p.lines.filter((l) => l.row === rowKey);
    /* A payroll line naming no region: the whole line, shared by the DO value. */
    expect(of('manpower_operation').map((l) => [l.text, l.cells, l.how])).toEqual([
      ["WAREHOUSE OPERATIONS SALARY - SEPT'26", { PG: 1_800, KL: 5_400, EM: 1_800 }, { kind: 'shared', wholeSen: 9_000 }],
    ]);
    expect(of('manpower_storekeeper')[0]!.how).toBeNull();
    expect(of('rental').map((l) => [l.accountCode, l.ref, l.cells])).toEqual([
      ['900-R004', expect.stringMatching(/^JE-/), { PG: 18_000, KL: 0, EM: 0 }],
      ['900-R005', expect.stringMatching(/^JE-/), { PG: 0, KL: 27_000, EM: 0 }],
      ['900-R046', expect.stringMatching(/^JE-/), { PG: 0, KL: 0, EM: 800 }],
    ]);
    /* August's insurance bill: its September part, 1 of 12. */
    expect(of('insurance').map((l) => [l.id, l.day, l.how])).toEqual([[`gl:${insurance.lineId}:2026-09`, '2026-08-15', { kind: 'spread', wholeSen: 12_000, part: 2, months: 12 }]]);
    expect(of('income_2990').map((l) => [l.ref, l.party, l.text])).toEqual([['HC-ODB-2610-001', '2990 HOME SDN BHD', "OPERATION CHARGES - SEP'26"]]);
    expect(of('do_value').map((l) => l.how)).toEqual([{ kind: 'dos', count: 2 }, { kind: 'dos', count: 6 }, { kind: 'dos', count: 2 }]);
    expect(of('do_income').find((l) => l.cells.KL !== 0)!.how).toEqual({ kind: 'rate', baseSen: 600_000, bp: 700 });
    expect(of('logistic_expense').find((l) => l.cells.KL !== 0)!.how).toEqual({ kind: 'transport', baseSen: 600_000 });
    expect(of('logistics_net').find((l) => l.cells.KL !== 0)!.how).toEqual({ kind: 'logistics', netSen: -700, fairIncomeSen: 2_000 });
    expect(of('sd_net').map((l) => [l.ref, l.text, l.party, l.cells, l.how])).toEqual([
      ['EV-PG-01', 'PENANG HOME FAIR', 'SPICE ARENA', { PG: 600, KL: 0, EM: 0 }, { kind: 'fair', incomeSen: 1_000, costSen: 400 }],
      ['EV-KL-01', 'KL HOME FAIR', 'MITEC', { PG: 0, KL: -600, EM: 0 }, { kind: 'fair', incomeSen: 2_000, costSen: 2_600 }],
    ]);
  });

  test('net, the Logistics and Setup/Dismantle results, and the net after both — a Total adds its regions', () => {
    const expense = { PG: 18_000 + 1_800 + 3_000, KL: 27_000 + 1_700 + 5_400 + 1_000, EM: 800 + 1_800 };
    expect(row('total_expense')).toEqual(expense);
    expect(row('net')).toEqual({ PG: 8_000 - expense.PG, KL: 36_000 - expense.KL, EM: 8_000 - expense.EM });
    /* Logistics' net less the fair income the Setup/Dismantle line carries. */
    expect(row('logistics_net')).toEqual({ PG: 3_000, KL: -1_000 + 300 - 2_000, EM: 500 });
    expect(row('sd_net')).toEqual({ PG: 600, KL: -600, EM: 0 });
    const after = row('net_after');
    expect(after.PG).toBe(row('net').PG + 3_000 + 600);
    expect(opSum(p, 'gross')).toBe(8_000 + 36_000 + 8_000);
    expect(opSum(p, 'net_after')).toBe(after.PG + after.KL + after.EM);
  });
});

describe('Operation: the job ads for warehouse posts', () => {
  test('a recruitment account\'s warehouse ad fills the sheet\'s job-ads row; its other ads are not Operation\'s', () => {
    const chart = new Map<string, DeptAccount>([['900-A004', acc('900-A004', 'ADVERTISEMENT - MANAGEMENT FEES', { department_row: 'hire' })]]);
    const p = buildOperationPnl({
      months: ['2026-10'], incomeBp: 700, logistics: new Map(), bills: [], chart, payroll: new Set(), spreadMonths: new Map(),
      legs: [leg('900-A004', '2026-10-20', 6_000, 'WAREHOUSE ASSISTANT - AUG26'), leg('900-A004', '2026-10-20', 2_500, 'ACCOUNT EXECUTIVE - AUG26')],
    });
    expect(p.perMonth[0]!.rows.recruitment).toEqual({ PG: 0, KL: 6_000, EM: 0 });
    expect(p.perMonth[0]!.rows.total_expense.KL).toBe(6_000);
  });
});

describe('G&A: its share of the Performance sales against what it booked', () => {
  const chart = new Map<string, DeptAccount>([
    ['900-S100', acc('900-S100', 'STAFF SALARIES & OVERTIME')],
    ['900-S200', acc('900-S200', "E'YER EPF")],
    ['900-D100', acc('900-D100', 'DIRECTOR REMUNERATION', { department_row: 'ga' })],
    ['900-P001', acc('900-P001', 'PRINTING & STATIONERY', { department_row: 'ga' })],
    ['900-R004', acc('900-R004', 'WAREHOUSE - (PENANG)', { department_row: 'op_rental_pg' })],
  ]);
  const layout: LayoutItem[] = [
    { kind: 'category', id: 'pl:warehouse', label: 'Warehouse expense', children: [{ kind: 'account', code: '900-R004' }] },
    {
      kind: 'category', id: 'pl:general', label: 'Administrative expense', children: [
        { kind: 'category', id: 'pl:general:salary', label: 'Salary & related', children: [
          { kind: 'account', code: '900-D100' }, { kind: 'account', code: '900-S100' }, { kind: 'account', code: '900-S200' },
        ] },
        { kind: 'category', id: 'pl:general:office', label: 'Office & admin', children: [{ kind: 'account', code: '900-P001' }] },
      ],
    },
  ] as LayoutItem[];
  const gLegs = [
    leg('900-S100', '2026-09-30', 8_000, "FINANCE - SALARY - SEP'26"),
    leg('900-S200', '2026-09-30', 1_000, "FINANCE - EPF - SEP'26"),
    leg('900-S100', '2026-10-31', 6_000, "IT SALARY - OCT'26"),
    leg('900-S100', '2026-10-31', 4_000, "OPERATION HELPER SALARY - OCT'26"),
    leg('900-S100', '2026-10-31', 2_000, "GROSS SALARY - OCT'26"),
    leg('900-D100', '2026-10-05', 20_000, "SALARY - SEP'26"),
    leg('900-P001', '2026-09-10', 500),
    leg('900-R004', '2026-09-07', 18_000),
    leg('900-P001', '2026-11-02', 999),
  ];
  const g = buildGaPnl({
    months: ['2026-09', '2026-10'],
    sales: new Map([['2026-09', 1_000_000], ['2026-10', 500_000]]),
    shareBp: 800,
    legs: gLegs,
    chart, payroll: new Set(['900-S100', '900-S200']), plan: HOUZS, layout, companyId: 1,
  });

  test('the share, the expenses and the surplus, month by month', () => {
    expect(g.perMonth).toEqual([
      { month: '2026-09', salesSen: 1_000_000, shareSen: 80_000, expenseSen: 9_500, surplusSen: 70_500 },
      { month: '2026-10', salesSen: 500_000, shareSen: 40_000, expenseSen: 26_000, surplusSen: 14_000 },
    ]);
  });

  test("the legs G&A counts are its figures: each tree row's month is its key's legs added up", () => {
    const lines = gaLines({ months: g.months, legs: gLegs, chart, payroll: new Set(['900-S100', '900-S200']), plan: HOUZS });
    const leaves = (n: (typeof g.tree)[number]): string[] => (n.kind === 'account' ? [n.key ?? n.code!] : n.children.flatMap(leaves));
    const nodes = (ns: typeof g.tree): typeof g.tree => ns.flatMap((n) => [n, ...nodes(n.children)]);
    for (const n of nodes(g.tree)) {
      const keys = new Set(leaves(n));
      for (const m of g.months) expect(lines.filter((l) => keys.has(l.key) && l.month === m).reduce((x, l) => x + l.sen, 0), `${n.id} ${m}`).toBe(n.cells?.[m] ?? 0);
    }
    expect(lines.filter((l) => l.key === 'team:FINANCE').map((l) => [l.leg.notes, l.sen])).toEqual([["FINANCE - SALARY - SEP'26", 8_000], ["FINANCE - EPF - SEP'26", 1_000]]);
  });

  test("G&A's accounts on the P&L's tree, the HQ teams under Salary & related", () => {
    const admin = g.tree.find((n) => n.id === 'pl:general')!;
    expect(g.tree.map((n) => n.id)).toEqual(['pl:general']);
    const salary = admin.children.find((n) => n.id === 'pl:general:salary')!;
    expect(salary.children.map((n) => n.key)).toEqual(['900-D100', 'team:FINANCE', 'team:IT']);
    expect(salary.children.find((n) => n.key === 'team:FINANCE')!.cells).toEqual({ '2026-09': 9_000 });
    expect(salary.cells).toEqual({ '2026-09': 9_000, '2026-10': 26_000 });
    expect(admin.amountSen).toBe(35_500);
    expect(g.teams.map((t) => [t.team, t.lines.length])).toEqual([['FINANCE', 2], ['IT', 1]]);
  });
});

describe('one department: its column of the P&L, month by month (the Exhibition P&L)', () => {
  const split = (month: string, k: number) => ({
    month,
    blocks: {
      tradingIncome: [{ code: '500-0001', name: 'SALES OF BEDDING', cells: { exhibition: 100_000 * k, ga: 0, none: 0 } }],
      costOfSales: [{ code: '601-0001', name: 'PURCHASES OF BEDDING', cells: { exhibition: 60_000 * k } }],
      otherIncome: [{ code: '599-0000', name: 'ADDITIONAL INCOME', cells: { exhibition: 0, ga: 500 } }],
      expenses: [
        { code: '900-R032', name: 'RENTAL - EXHIBITION', cells: { exhibition: 20_000 * k } },
        { code: '900-S100', name: 'STAFF SALARIES & OVERTIME', cells: { exhibition: 1_000, ga: 8_000 } },
        { code: '900-P001', name: 'PRINTING & STATIONERY', cells: { ga: 300 } },
      ],
      taxation: [],
    },
  });
  const layout = {
    expenses: [
      { kind: 'category', id: 'pl:exh', label: 'Exhibition & roadshow expense', children: [{ kind: 'account', code: '900-R032' }] },
      { kind: 'category', id: 'pl:general:salary', label: 'Salary & related', children: [{ kind: 'account', code: '900-S100' }] },
    ],
  } as unknown as Record<string, LayoutItem[]>;
  const v = buildDeptView({
    dept: 'exhibition', basis: 'actual', months: ['2026-09', '2026-10'], split: [split('2026-09', 1), split('2026-10', 2)], layout, companyId: 1, orders: null, charges: null,
  });

  test('sales less cost of sales less its expenses, each month', () => {
    expect(v.basis).toBe('actual');
    expect(v.orders).toBeNull();
    expect(v.charges).toEqual([]);
    expect(v.perMonth).toEqual([
      { month: '2026-09', salesSen: 100_000, costOfSalesSen: 60_000, grossSen: 40_000, otherIncomeSen: 0, expensesSen: 21_000, taxationSen: 0, chargesSen: 0, baseSen: null, netSen: 19_000 },
      { month: '2026-10', salesSen: 200_000, costOfSalesSen: 120_000, grossSen: 80_000, otherIncomeSen: 0, expensesSen: 41_000, taxationSen: 0, chargesSen: 0, baseSen: null, netSen: 39_000 },
    ]);
  });

  test("only the department's own lines, on the P&L's tree, each with its figure per month", () => {
    expect(v.tree.expenses.map((n) => n.id)).toEqual(['pl:exh', 'pl:general:salary']);
    expect(v.tree.expenses[0]!.cells).toEqual({ '2026-09': 20_000, '2026-10': 40_000 });
    expect(v.tree.expenses[1]!.children[0]!.cells).toEqual({ '2026-09': 1_000, '2026-10': 1_000 });
    expect(v.tree.otherIncome).toEqual([]);
  });
});

describe('the Exhibition on its orders (owner 2026-11-25): the Performance P&L\'s sales and cost, its own expenses and the commission bills', () => {
  /* October's books carry a commission release of 9,000 on 900-C003; the bills are 15,000 (Sep) and 18,000 (Oct). */
  const split = (month: string, k: number, release: number) => ({
    month,
    blocks: {
      tradingIncome: [{ code: '500-0001', name: 'SALES OF BEDDING', cells: { exhibition: 999_999 } }],
      costOfSales: [{ code: '601-0001', name: 'PURCHASES OF BEDDING', cells: { exhibition: 888_888 } }],
      otherIncome: [],
      expenses: [
        { code: '900-R032', name: 'RENTAL - EXHIBITION', cells: { exhibition: 20_000 * k } },
        ...(release ? [{ code: '900-C003', name: 'COMMISSION ( EVENT )', cells: { exhibition: release } }] : []),
      ],
      taxation: [],
    },
  });
  const month = (m: string, k: number, commission: OrdersMonthIn['commission']): OrdersMonthIn => ({
    month: m,
    groups: [
      { key: 'bedframe', label: 'Bedframe', salesSen: 70_000 * k, cogsSen: 30_000 * k },
      { key: 'mattress', label: 'Mattress', salesSen: 50_000 * k, cogsSen: 20_000 * k },
      { key: 'sofa', label: 'Sofa', salesSen: 0, cogsSen: 0 },
      { key: 'service', label: 'Service / transport income', salesSen: 5_000, cogsSen: 0 },
    ],
    orders: { counted: 3 * k, notDelivered: k },
    commission,
  });
  const layout = {
    expenses: [
      { kind: 'category', id: 'pl:exh', label: 'Exhibition & roadshow expense', children: [{ kind: 'account', code: '900-R032' }] },
      { kind: 'category', id: 'pl:general:commission', label: 'Commission', children: [{ kind: 'account', code: '900-C003' }] },
    ],
  } as unknown as Record<string, LayoutItem[]>;
  const label = '900-C003 COMMISSION ( EVENT ) — the commission bills for Sep 2026, Oct 2026, in place of the monthly release';
  const months = [month('2026-09', 1, { billSen: 15_000, releaseSen: 0 }), month('2026-10', 2, { billSen: 18_000, releaseSen: 9_000 })];
  const v = buildDeptView({
    dept: 'exhibition', basis: 'performance', months: ['2026-09', '2026-10'], split: [split('2026-09', 1, 0), split('2026-10', 2, 9_000)], layout, companyId: 1,
    orders: { months, commission: { code: '900-C003', name: 'COMMISSION ( EVENT )', label } }, charges: null,
  });

  test("sales and cost of sales are the orders' product groups, never the books'; a group with nothing is left out", () => {
    expect(v.basis).toBe('performance');
    expect(v.tree.tradingIncome.map((n) => [n.key, n.label, n.cells])).toEqual([
      ['order:bedframe', 'Bedframe', { '2026-09': 70_000, '2026-10': 140_000 }],
      ['order:mattress', 'Mattress', { '2026-09': 50_000, '2026-10': 100_000 }],
      ['order:service', 'Service / transport income', { '2026-09': 5_000, '2026-10': 5_000 }],
    ]);
    expect(v.tree.costOfSales.map((n) => [n.key, n.cells])).toEqual([
      ['order:bedframe', { '2026-09': 30_000, '2026-10': 60_000 }],
      ['order:mattress', { '2026-09': 20_000, '2026-10': 40_000 }],
    ]);
    expect(v.orders).toEqual({ counted: 9, notDelivered: 3 });
  });

  test('the commission account reads each month\'s bills in place of the release; every other expense as booked', () => {
    const commission = v.tree.expenses.find((n) => n.id === 'pl:general:commission')!.children[0]!;
    expect(commission.cells).toEqual({ '2026-09': 15_000, '2026-10': 18_000 });
    expect(commission.label).toBe(label);
    expect(v.perMonth).toEqual([
      { month: '2026-09', salesSen: 125_000, costOfSalesSen: 50_000, grossSen: 75_000, otherIncomeSen: 0, expensesSen: 35_000, taxationSen: 0, chargesSen: 0, baseSen: null, netSen: 40_000 },
      { month: '2026-10', salesSen: 245_000, costOfSalesSen: 100_000, grossSen: 145_000, otherIncomeSen: 0, expensesSen: 58_000, taxationSen: 0, chargesSen: 0, baseSen: null, netSen: 87_000 },
    ]);
  });

  test('a commission account that counts in another department is left as booked', () => {
    const w = buildDeptView({
      dept: 'exhibition', basis: 'performance', months: ['2026-10'], split: [split('2026-10', 2, 9_000)], layout, companyId: 1,
      orders: { months: [month('2026-10', 2, null)], commission: null }, charges: null,
    });
    expect(w.perMonth[0]!.expensesSen).toBe(40_000 + 9_000);
  });
});

describe('the selling department pays the others (owner 2026-11-25: G&A 5%, Operation 7%, Setup & dismantle 1%)', () => {
  /* Made-up: September's sales 100,000 of which service 4,000; the fair transport 900-T031 booked 1,500 and the
     terminal charges 900-T009 booked 700; the booth setup 900-B003 stays as booked (「不是replace booth setup」). */
  const split = [{
    month: '2026-09',
    blocks: {
      tradingIncome: [
        { code: '500-0001', name: 'SALES OF BEDDING', cells: { exhibition: 96_000 } },
        { code: '503-0000', name: 'SERVICE INCOME', cells: { exhibition: 4_000 } },
      ],
      costOfSales: [{ code: '601-0001', name: 'PURCHASES OF BEDDING', cells: { exhibition: 50_000 } }],
      otherIncome: [],
      expenses: [
        { code: '900-B003', name: 'BOOTH SET UP', cells: { exhibition: 3_000 } },
        { code: '900-T009', name: 'TERMINAL INTEREST CHARGES', cells: { exhibition: 700 } },
        { code: '900-T031', name: 'TRANSPORT FAIR (KL)', cells: { exhibition: 1_500 } },
      ],
      taxation: [],
    },
  }];
  const layout = {
    expenses: [
      { kind: 'category', id: 'pl:exh', label: 'Exhibition & roadshow expense', children: [{ kind: 'account', code: '900-B003' }, { kind: 'account', code: '900-T031' }] },
      { kind: 'category', id: 'pl:bank', label: 'Bank charges', children: [{ kind: 'account', code: '900-T009' }] },
    ],
  } as unknown as Record<string, LayoutItem[]>;
  const rates = { gaBp: 500, operationBp: 700, logisticsBp: 300, setupDismantleBp: 100, merchandiseBp: 200 };
  const payees = { ga: true, operation: true, logistics: true, setupDismantle: true };
  const base = bookedSalesExService(split, new Set(['503-0000']), 'exhibition');
  const chargesFor = (basis: 'actual' | 'performance'): DeptCharges => ({
    months: chargesOf({ months: ['2026-09'], base, rates, payees, basis }), rates,
    moved: new Set(['900-T030', '900-T031']),
    merchandise: basis === 'performance' ? { codes: new Set(['900-T009']) } : null,
  });
  const view = (basis: 'actual' | 'performance') => buildDeptView({
    dept: 'exhibition', basis, months: ['2026-09'], split, layout, companyId: 1, orders: null, charges: chargesFor(basis),
  });

  test("the base is the selling department's sales less the service group's", () => {
    expect([...base]).toEqual([['2026-09', 96_000]]);
  });

  test('Actual: the fair transport leaves, every other expense as booked, the three charges paid', () => {
    const v = view('actual');
    expect(v.tree.expenses.flatMap((n) => n.children.map((x) => [x.code, x.cells]))).toEqual([
      ['900-B003', { '2026-09': 3_000 }], ['900-T009', { '2026-09': 700 }],
    ]);
    expect(v.charges.map((n) => [n.id, n.cells])).toEqual([
      ['charge:ga', { '2026-09': 4_800 }], ['charge:operation', { '2026-09': 6_720 }], ['charge:setupDismantle', { '2026-09': 960 }],
    ]);
    expect(v.perMonth[0]).toMatchObject({ salesSen: 100_000, expensesSen: 3_700, chargesSen: 12_480, baseSen: 96_000, netSen: 100_000 - 50_000 - 3_700 - 12_480 });
  });

  test('Performance: merchandise at 2% stands where the terminal charges stood, named with what was booked', () => {
    const v = view('performance');
    const merch = v.tree.expenses.find((n) => n.id === 'pl:bank')!.children[0]!;
    expect([merch.code, merch.cells]).toEqual(['900-T009', { '2026-09': 1_920 }]);
    expect(merch.label).toBe('Merchandise — 2% of sales excluding service, in place of 900-T009 TERMINAL INTEREST CHARGES (7.00 booked)');
    expect(v.perMonth[0]).toMatchObject({ expensesSen: 3_000 + 1_920, chargesSen: 12_480 });
  });

  test('a company paying G&A only (2990) carries one charge, nothing moved, no merchandise', () => {
    const only = chargesOf({ months: ['2026-09'], base, rates, payees: { ga: true, operation: false, logistics: false, setupDismantle: false }, basis: 'actual' });
    const v = buildDeptView({
      dept: 'exhibition', basis: 'actual', months: ['2026-09'], split, layout, companyId: 1, orders: null,
      charges: { months: only, rates, moved: new Set(), merchandise: null },
    });
    expect(v.charges.map((n) => n.id)).toEqual(['charge:ga']);
    expect(v.perMonth[0]).toMatchObject({ expensesSen: 5_200, chargesSen: 4_800 });
  });

  test("Setup & dismantle's fair transport as booked, by account and month", () => {
    expect(bookedByAccount(split, new Set(['900-T030', '900-T031']))).toEqual([{ code: '900-T031', name: 'TRANSPORT FAIR (KL)', cells: { '2026-09': 1_500 } }]);
  });
});

describe('All: each department\'s own P&L in a few figures, side by side (owner 2026-11-25)', () => {
  test('a department\'s own P&L: its months added up, taxation with its expenses', () => {
    const v = buildDeptView({
      dept: 'showroom', basis: 'actual', months: ['2026-09'], companyId: 1, orders: null, charges: null, layout: {},
      split: [{
        month: '2026-09',
        blocks: {
          tradingIncome: [{ code: '500-0001', name: 'SALES', cells: { showroom: 100_000 } }],
          costOfSales: [{ code: '601-0001', name: 'PURCHASES', cells: { showroom: 60_000 } }],
          otherIncome: [{ code: '599-0000', name: 'ADDITIONAL INCOME', cells: { showroom: 1_000 } }],
          expenses: [{ code: '900-R009', name: 'SHOW ROOM', cells: { showroom: 20_000, none: 700 } }],
          taxation: [{ code: '950-0001', name: 'TAX', cells: { showroom: 2_000 } }],
        },
      }],
    });
    expect(summaryOfDept(v)).toEqual({ incomeSen: 100_000, costSen: 60_000, grossSen: 40_000, otherIncomeSen: 1_000, expensesSen: 22_000, chargesSen: 0, profitSen: 19_000 });
  });

  test('Operation: 7% of the sales and what it bills, less the 3% it passes to Logistics and the warehouse', () => {
    const op = buildOperationPnl({
      months: ['2026-09'], incomeBp: 700,
      logistics: new Map<string, LogisticsMonthIn>([['2026-09', { doValue: { KL: 1_000_000 }, doCount: { KL: 4 }, transportIncome: { KL: 30_000 }, fairIncome: {}, net: { KL: 50_000 }, fairs: [] }]]),
      bills: [], legs: [leg('900-R005', '2026-09-07', 25_000)],
      chart: new Map([['900-R005', acc('900-R005', 'WAREHOUSE - (BELAKONG)', { department_row: 'op_rental_kl' })]]),
      payroll: new Set(), spreadMonths: new Map(),
    });
    const charges = chargesOf({
      months: ['2026-09'], base: new Map([['2026-09', 500_000]]), basis: 'performance',
      rates: { gaBp: 500, operationBp: 700, logisticsBp: 300, setupDismantleBp: 100, merchandiseBp: 0 },
      payees: { ga: true, operation: true, logistics: true, setupDismantle: true },
    });
    const unit = buildOperationUnit({
      months: ['2026-09'], charges, operationBp: 700, logisticsBp: 300,
      income: [{ key: 'income_warehouse', label: 'Warehouse income' }], expenses: [{ key: 'rental', label: 'Rental Warehouse' }],
      rows: new Map([['2026-09', new Map(Object.entries(op.perMonth[0]!.rows).map(([k, c]) => [k, c.PG + c.KL + c.EM]))]]),
    });
    expect(unit.rows.map((r) => [r.key, r.group, r.cells['2026-09']])).toEqual([['from_selling', 'income', 35_000], ['rental', 'expense', 25_000], ['to_logistics', 'paid', 15_000]]);
    expect(unit.perMonth).toEqual([{ month: '2026-09', incomeSen: 35_000, expenseSen: 25_000, paidSen: 15_000, netSen: -5_000 }]);
    expect(summaryOfUnit(unit)).toEqual({ incomeSen: 35_000, costSen: 0, grossSen: 35_000, otherIncomeSen: 0, expensesSen: 25_000, chargesSen: 15_000, profitSen: -5_000 });
    /* The by-DO sheet is unchanged: its own 7% of the DO value and its own last line. */
    expect(opSum(op, 'net_after')).toBe(65_000);
  });

  test('Logistics by the 3%, G&A against its share, and the departments added up: what they pay each other comes out even', () => {
    const charges = chargesOf({
      months: ['2026-09'], base: new Map([['2026-09', 500_000]]), basis: 'actual',
      rates: { gaBp: 500, operationBp: 700, logisticsBp: 300, setupDismantleBp: 100, merchandiseBp: 200 },
      payees: { ga: true, operation: true, logistics: true, setupDismantle: true },
    });
    const logistics = summaryOfUnit(buildLogisticsUnit({
      months: ['2026-09'], charges, logisticsBp: 300, trips: true,
      rows: new Map([['2026-09', new Map([['do_income', 99_999], ['sd_income', 2_000], ['outsource', 12_000], ['manpower', 4_000]])]]),
    }));
    expect(logistics).toEqual({ incomeSen: 17_000, costSen: 0, grossSen: 17_000, otherIncomeSen: 0, expensesSen: 16_000, chargesSen: 0, profitSen: 1_000 });
    const ga: GaPnl = {
      months: ['2026-09'], shareBp: 500, tree: [], teams: [],
      perMonth: [{ month: '2026-09', salesSen: 500_000, shareSen: 25_000, expenseSen: 30_000, surplusSen: -5_000 }],
    };
    expect(summaryOfGa(ga)).toEqual({ incomeSen: 25_000, costSen: 0, grossSen: 25_000, otherIncomeSen: 0, expensesSen: 30_000, chargesSen: 0, profitSen: -5_000 });
    expect(addSummaries([logistics, summaryOfGa(ga)])).toEqual({ incomeSen: 42_000, costSen: 0, grossSen: 42_000, otherIncomeSen: 0, expensesSen: 46_000, chargesSen: 0, profitSen: -4_000 });
  });

  test('an expense account no department claims is named, its months added up', () => {
    const blocks = (none: number) => ({
      tradingIncome: [], costOfSales: [], otherIncome: [], taxation: [],
      expenses: [{ code: '900-U014', name: 'UPKEEP OF LORI', cells: { ga: 0, none } }, { code: '900-P001', name: 'PRINTING', cells: { ga: 300, none: 0 } }],
    });
    expect(unassignedOf([{ month: '2026-09', blocks: blocks(200) }, { month: '2026-10', blocks: blocks(300) }]))
      .toEqual([{ code: '900-U014', name: 'UPKEEP OF LORI', amountSen: 500 }]);
  });
});
