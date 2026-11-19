/* The Department P&L's arithmetic (owner 2026-11-19). Figures are made up; the
   words are the books' own (the salary journal's team lines, the Other Debtor
   recharges, the warehouse accounts).
     • All: a P&L line split across the departments always adds up to the line;
     • Operation: the owner's "Operation PNL - Auto" sheet by region — 7% of the DO
       value, the recharges in the month they name, (-) the Logistics P&L's own
       Transport Income, the warehouse rows, manpower by team line (a region named,
       else shared by the DO value), insurance spread over 12 months, then the
       Logistics and Setup/Dismantle results and the net after both;
     • G&A: its share of the Performance sales against what the HQ teams and the
       G&A accounts booked, on the P&L's own tree. */

import { describe, expect, test } from 'vitest';
import {
  buildGaPnl, buildOperationPnl, opSum, shareByValue, splitLine, type LogisticsMonthIn,
} from './department-pnl';
import type { DeptAccount } from './department-rows';
import type { BillLine, Leg } from './logistics-pnl';
import type { LayoutItem } from '../../acc/report-layout';

const acc = (account_code: string, account_name: string, extra: Partial<DeptAccount> = {}): DeptAccount =>
  ({ account_code, account_name, account_type: 'EXPENSE', is_active: true, logistics_row: null, department_row: null, ...extra });
let seq = 0;
const leg = (accountCode: string, day: string, debitSen: number, notes: string | null = null, creditSen = 0): Leg =>
  ({ lineId: `l${++seq}`, accountCode, accountName: null, day, debitSen, creditSen, notes, docNo: `JE-${seq}` });

describe('All: one P&L line across the departments', () => {
  const staff = acc('900-S100', 'STAFF SALARIES & OVERTIME');
  test('a payroll account splits by its team lines; what the legs do not explain stays with the account', () => {
    const cells = splitLine({
      amountSen: 10_000, sign: 1, account: staff, payroll: true, recharge: false,
      legs: [
        { accountCode: '900-S100', notes: "FINANCE - SALARY - OCT2026", debitSen: 3_000, creditSen: 0 },
        { accountCode: '900-S100', notes: "OPERATION HELPER SALARY - OCT'26", debitSen: 2_000, creditSen: 0 },
        { accountCode: '900-S100', notes: "WAREHOUSE OPERATIONS SALARY - OCT'26", debitSen: 4_000, creditSen: 0 },
        { accountCode: '900-S100', notes: "GROSS SALARY - OCT'26", debitSen: 500, creditSen: 0 },
      ],
    });
    expect(cells).toEqual({ ga: 3_000, logistics: 2_000, operation: 4_000, none: 1_000 });
    expect(Object.values(cells).reduce((a, b) => a + b, 0)).toBe(10_000);
  });

  test('an income line reads credit-positive; an account no rule mixes goes whole to its department', () => {
    const inc = acc('599-0000', 'ADDITIONAL INCOME', { account_type: 'INCOME' });
    expect(splitLine({
      amountSen: 1_500, sign: -1, account: inc, payroll: false, recharge: true,
      legs: [
        { accountCode: '599-0000', notes: "OPERATION CHARGES - SEP'26", debitSen: 0, creditSen: 1_000 },
        { accountCode: '599-0000', notes: "LOGISTICS CHARGES - SEP'26", debitSen: 0, creditSen: 600 },
        { accountCode: '599-0000', notes: 'SUNDRY', debitSen: 100, creditSen: 0 },
      ],
    })).toEqual({ ga: 0, operation: 1_000, logistics: 600, none: -100 });
    expect(splitLine({ amountSen: 777, sign: 1, account: acc('900-R004', 'WAREHOUSE - (PENANG)', { department_row: 'op_rental_pg' }), payroll: false, recharge: false, legs: undefined }))
      .toEqual({ ga: 0, operation: 777, logistics: 0, none: 0 });
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
    fairs: [{ region: 'PG', incomeSen: 1_000, costSen: 400 }, { region: 'KL', incomeSen: 2_000, costSen: 2_600 }],
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
  const g = buildGaPnl({
    months: ['2026-09', '2026-10'],
    sales: new Map([['2026-09', 1_000_000], ['2026-10', 500_000]]),
    shareBp: 800,
    legs: [
      leg('900-S100', '2026-09-30', 8_000, "FINANCE - SALARY - SEP'26"),
      leg('900-S200', '2026-09-30', 1_000, "FINANCE - EPF - SEP'26"),
      leg('900-S100', '2026-10-31', 6_000, "IT SALARY - OCT'26"),
      leg('900-S100', '2026-10-31', 4_000, "OPERATION HELPER SALARY - OCT'26"),
      leg('900-S100', '2026-10-31', 2_000, "GROSS SALARY - OCT'26"),
      leg('900-D100', '2026-10-05', 20_000, "SALARY - SEP'26"),
      leg('900-P001', '2026-09-10', 500),
      leg('900-R004', '2026-09-07', 18_000),
      leg('900-P001', '2026-11-02', 999),
    ],
    chart, payroll: new Set(['900-S100', '900-S200']), layout, companyId: 1,
  });

  test('the share, the expenses and the surplus, month by month', () => {
    expect(g.perMonth).toEqual([
      { month: '2026-09', salesSen: 1_000_000, shareSen: 80_000, expenseSen: 9_500, surplusSen: 70_500 },
      { month: '2026-10', salesSen: 500_000, shareSen: 40_000, expenseSen: 26_000, surplusSen: 14_000 },
    ]);
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
