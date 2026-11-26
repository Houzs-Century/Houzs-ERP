/* The Overall P&L's views side by side (owner 2026-11-25: 一张表并排). Pinned:
   the Performance P&L and the Forecast P&L land on the P&L's own rows — an
   account on its code's row, a category under the layout's id — so a row is
   the same row in every column; Performance's sales go to each group's bound
   sales account (groups sharing one add up, an unbound group under Unassigned,
   named), its cost of sales is one line of its own, its expenses are its own
   report's (the rate's line under the account it replaces, the commission at
   the bills); the Forecast adds its months up; no month, no Forecast. */
import { describe, expect, test } from 'vitest';
import type { ForecastFigures, ForecastLine } from '../scm/shared/forecast-pnl';
import type { PerformanceReport } from './performance-pnl';
import { ORDERS_COST_ID, forecastOnPnl, performanceOnPnl, salesAccountOfGroup } from './pnl-views';
import type { LaidNode, Layout } from './report-layout';

const LAYOUT: Layout = {
  version: 1,
  blocks: {
    tradingIncome: [{ kind: 'category', id: 'pl:sales', label: 'Sales', children: [{ kind: 'account', code: '500-0001' }, { kind: 'account', code: '500-0003' }, { kind: 'account', code: '503-0000' }] }],
    costOfSales: [{ kind: 'account', code: '601-0001' }],
    otherIncome: [{ kind: 'account', code: '599-0000' }],
    expenses: [
      { kind: 'category', id: 'pl:exhibition', label: 'Exhibition', children: [{ kind: 'account', code: '900-E001' }] },
      { kind: 'category', id: 'pl:general', label: 'Administrative expense', children: [{ kind: 'account', code: '900-O001' }, { kind: 'account', code: '900-C003' }] },
    ],
    taxation: [{ kind: 'account', code: '950-0001' }],
  },
};
const BINDINGS = [
  { group_code: 'MATTRESS', sales_account: '500-0001' },
  { group_code: 'BEDFRAME', sales_account: '500-0001' },
  { group_code: 'SOFA', sales_account: '500-0003' },
  { group_code: 'SERVICE', sales_account: '503-0000' },
  { group_code: 'DINING', sales_account: ' ' },
];
const NAMES: Record<string, string> = { '500-0001': 'SALES OF BEDDING', '500-0003': 'SALES OF SOFA', '503-0000': 'SERVICE INCOME' };
const nameOf = (code: string) => NAMES[code] ?? code;

const group = (key: string, label: string, salesSen: number, cogsSen: number) => ({ key, label, lines: 1, salesSen, cogsSen, gpSen: salesSen - cogsSen, gpPct: null });
const PERF = {
  from: '2026-10-01', to: '2026-10-31',
  orders: { counted: 3, notDelivered: 0, excludedDraft: 0, excludedCancelled: 0 },
  groups: [group('bedframe', 'Bedframe', 20_000_00, 8_000_00), group('mattress', 'Mattress', 100_000_00, 40_000_00), group('sofa', 'Sofa', 50_000_00, 25_000_00), group('dining', 'Dining', 5_000_00, 2_000_00), group('others', 'Others', 0, 0)],
  totals: { salesSen: 175_000_00, cogsSen: 75_000_00, gpSen: 100_000_00, gpPct: 57.1, salesExServiceSen: 175_000_00 },
  operatingExpense: { rateBp: 1500, baseSen: 175_000_00, amountSen: 26_250_00, account: '900-O001', accountName: 'OPERATING EXPENSE', accountFound: true, bookedSen: 30_000_00, also: [], alsoBookedSen: 0 },
  inRate: [],
  otherIncome: [{ code: '599-0000', name: 'ADDITIONAL INCOME', amountSen: 1_000_00 }],
  otherIncomeSen: 1_000_00,
  otherExpenses: [{ code: '900-C003', name: 'COMMISSION ( EVENT )', amountSen: 9_000_00 }, { code: '900-E001', name: 'BOOTH RENTAL', amountSen: 12_000_00 }],
  otherExpensesSen: 21_000_00,
  netSen: 100_000_00 + 1_000_00 - 26_250_00 - 21_000_00,
  netPct: null,
  settings: { rateBp: 1500, account: '900-O001', also: [] },
  commission: { code: '900-C003', name: 'COMMISSION ( EVENT )', billSen: 9_000_00, months: ['2026-10'], releaseSen: 4_000_00 },
} as unknown as PerformanceReport;

const find = (nodes: LaidNode[], id: string): LaidNode | undefined => {
  for (const n of nodes) {
    if (n.id === id) return n;
    const inner = find(n.children, id);
    if (inner) return inner;
  }
  return undefined;
};

describe('the item groups’ sales accounts', () => {
  test('a group finds its bound sales account in any case; a blank binding is none', () => {
    const of = salesAccountOfGroup(BINDINGS);
    expect(of('mattress')).toBe('500-0001');
    expect(of('Sofa')).toBe('500-0003');
    expect(of('dining')).toBeNull();
    expect(of('others')).toBeNull();
  });
});

describe('the Performance P&L on the P&L’s tree', () => {
  const side = performanceOnPnl(PERF, LAYOUT, 1, salesAccountOfGroup(BINDINGS), nameOf);

  test('its sales on the groups’ sales accounts, groups sharing one added up; an unbound group under Unassigned, named', () => {
    const sales = find(side.layout.tradingIncome, 'pl:sales')!;
    expect(sales.amountSen).toBe(170_000_00);
    expect(find(sales.children, 'acc:500-0001')).toMatchObject({ amountSen: 120_000_00, label: '500-0001 · SALES OF BEDDING' });
    expect(find(sales.children, 'acc:500-0003')).toMatchObject({ amountSen: 50_000_00 });
    const unassigned = find(side.layout.tradingIncome, 'unassigned')!;
    expect(unassigned.children.map((n) => [n.label, n.amountSen])).toEqual([['Dining (no sales account)', 5_000_00]]);
    expect(find(side.layout.tradingIncome, 'acc:group:others')).toBeUndefined();
  });

  test('its cost of sales is one line of its own, never a purchase account’s row', () => {
    expect(side.layout.costOfSales).toEqual([expect.objectContaining({ id: ORDERS_COST_ID, amountSen: 75_000_00, pct: 42.9 })]);
    expect(find(side.layout.costOfSales, 'acc:601-0001')).toBeUndefined();
  });

  test('its other income and expenses as its own report has them: the rate under the account it replaces, the commission at the bills', () => {
    expect(find(side.layout.otherIncome, 'acc:599-0000')?.amountSen).toBe(1_000_00);
    const general = find(side.layout.expenses, 'pl:general')!;
    expect(find(general.children, 'acc:900-O001')).toMatchObject({ amountSen: 26_250_00 });
    expect(find(general.children, 'acc:900-O001')!.label).toMatch(/15/);
    expect(find(general.children, 'acc:900-C003')!.label).toMatch(/commission bills for Oct 2026/);
    expect(find(side.layout.expenses, 'pl:exhibition')?.amountSen).toBe(12_000_00);
  });

  test('its totals are its own report’s, net = gross + other income − expenses, and no taxation', () => {
    const t = side.totals;
    expect(t).toMatchObject({ tradingIncomeSen: 175_000_00, costOfSalesSen: 75_000_00, grossProfitSen: 100_000_00, otherIncomeSen: 1_000_00, expensesSen: 47_250_00, taxationSen: 0 });
    expect(t.netProfitSen).toBe(t.grossProfitSen + t.otherIncomeSen - t.expensesSen);
    expect(t.profitBeforeTaxSen).toBe(t.netProfitSen);
    expect(side.taxation).toEqual([]);
    expect(side.layout.baseSen).toBe(175_000_00);
  });
});

describe('the Forecast P&L on the P&L’s tree', () => {
  const line = (code: string, name: string, block: ForecastLine['block'], amountSen: number): ForecastLine =>
    ({ code, name, section: '', block, amountSen, bp: null, basisSen: 0, keyed: 'amount', bySupplier: [] });
  const month = (sales: number, purchase: number, booth: number, tax: number): ForecastFigures => {
    const lines = [
      line('500-0001', 'SALES OF BEDDING', 'tradingIncome', sales),
      line('601-0001', 'PURCHASE OF BEDDING', 'costOfSales', purchase),
      line('900-E001', 'BOOTH RENTAL', 'expenses', booth),
      line('950-0001', 'INCOME TAX', 'taxation', tax),
    ];
    const gross = sales - purchase;
    return { salesSen: sales, lines, totals: { tradingIncomeSen: sales, costOfSalesSen: purchase, grossProfitSen: gross, otherIncomeSen: 0, expensesSen: booth, profitBeforeTaxSen: gross - booth, taxationSen: tax, netProfitSen: gross - booth - tax } };
  };

  test('each account added up over the months on its row; the totals the months’ own; the taxation lines kept', () => {
    const side = forecastOnPnl([month(100_000_00, 50_000_00, 10_000_00, 1_000_00), month(120_000_00, 60_000_00, 10_000_00, 2_000_00)], LAYOUT, 1)!;
    expect(find(side.layout.tradingIncome, 'acc:500-0001')?.amountSen).toBe(220_000_00);
    expect(find(side.layout.costOfSales, 'acc:601-0001')?.amountSen).toBe(110_000_00);
    expect(find(side.layout.expenses, 'pl:exhibition')?.amountSen).toBe(20_000_00);
    expect(side.totals).toEqual({
      tradingIncomeSen: 220_000_00, costOfSalesSen: 110_000_00, grossProfitSen: 110_000_00, otherIncomeSen: 0, expensesSen: 20_000_00,
      profitBeforeTaxSen: 90_000_00, taxationSen: 3_000_00, netProfitSen: 87_000_00,
    });
    expect(side.taxation.map((l) => [l.code, l.amountSen])).toEqual([['950-0001', 3_000_00]]);
    expect(find(side.layout.costOfSales, 'acc:601-0001')?.pct).toBe(50);
  });

  test('no month with a forecast, no Forecast', () => {
    expect(forecastOnPnl([], LAYOUT, 1)).toBeNull();
  });
});
