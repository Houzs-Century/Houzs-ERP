/* The report sheet — a Finance report as the screen shows it, the one shape
   Excel and PDF draw (owner 2026-09-19: 我这页显示什么就要 export 什么). Pinned:
   a statement's lines as rows of amount and %; the Cash Flow with the ticked
   columns, folded to the level, a zero in an account column a dash; the
   Performance P&L's two tables and notes; the monthly grid in amounts mode
   (a % beside each amount) and in % mode; a cell's text. */
import { describe, expect, it } from 'vitest';
import type { LaidNode } from './report-layout';
import type { FlatLine, MonthColumn, MonthlyLine } from './report-monthly';
import type { RpReport } from './rp-report-queries';
import type { PerformanceReport } from './performance-report-queries';
import { cashFlowTable, exportFileName, monthlyTable, performanceTables, sheetText, statementTable } from './report-sheet';

const acc = (code: string, label: string, amountSen: number, pct: number | null): LaidNode =>
  ({ kind: 'account', id: `acc:${code}`, label, code, key: code, amountSen, pct, children: [] });

describe('a statement as a table', () => {
  it('turns the screen\'s lines into rows of amount and %; a block title carries no figure', () => {
    const lines: FlatLine[] = [
      { id: 'blk:expenses', label: 'Expenses', kind: 'block', depth: 0, amountSen: 0, pct: null },
      { id: 'cat', label: 'Operating Expense', kind: 'category', depth: 1, amountSen: 10_500, pct: 10.5 },
      { id: 'acc:900-A001', label: '900-A001 · ADVERT', kind: 'row', depth: 2, amountSen: 12_000, pct: 12, code: '900-A001' },
      { id: 'tot:expenses', label: 'Total expenses', kind: 'total', depth: 0, amountSen: 10_500, pct: 10.5 },
      { id: 'net:net', label: 'NET PROFIT', kind: 'net', depth: 0, amountSen: 41_500, pct: 41.5 },
    ];
    const t = statementTable(lines, '% of sales');
    expect(t.columns).toEqual([{ label: 'Amount', kind: 'amount' }, { label: '% of sales', kind: 'pct' }]);
    expect(t.rows).toEqual([
      { kind: 'block', depth: 0, label: 'Expenses', cells: [] },
      { kind: 'category', depth: 1, label: 'Operating Expense', cells: [10_500, 10.5] },
      { kind: 'row', depth: 2, label: '900-A001 · ADVERT', cells: [12_000, 12] },
      { kind: 'total', depth: 0, label: 'Total expenses', cells: [10_500, 10.5] },
      { kind: 'net', depth: 0, label: 'NET PROFIT', cells: [41_500, 41.5] },
    ]);
  });

  it('prints a cell as the screen would: the report\'s money dress, one-decimal %, a dash for nothing', () => {
    expect(sheetText({ label: 'Amount', kind: 'amount' }, -123_456)).toBe('(1,234.56)');
    expect(sheetText({ label: '%', kind: 'pct' }, 12.34)).toBe('12.3%');
    expect(sheetText({ label: '%', kind: 'pct' }, null)).toBe('-');
    expect(sheetText({ label: 'Amount', kind: 'amount' }, 5, (sen) => `RM ${sen}`)).toBe('RM 5');
    expect(exportFileName('pnl', '2026-09-01', '2026-09-19', 'xlsx')).toBe('pnl-2026-09-01-to-2026-09-19.xlsx');
    expect(exportFileName('balance-sheet', '2026-09-19', '2026-09-19', 'pdf')).toBe('balance-sheet-2026-09-19.pdf');
  });
});

const rp: RpReport = {
  from: '2026-07-01', to: '2026-07-31', byParty: false,
  columns: [{ code: '310-0010', name: 'BANK' }, { code: '320-0000', name: 'CASH' }],
  opening: { '310-0010': -10000, '320-0000': 0 },
  receipts: [], payments: [],
  totals: { receipts: { '310-0010': 50000 }, payments: { '310-0010': 30000 }, closing: { '310-0010': 10000, '320-0000': 0 }, openingTotalSen: -10000, receiptsTotalSen: 50000, paymentsTotalSen: 30000, closingTotalSen: 10000 },
  entries: [],
  layout: {
    stored: true, inSen: 50000, outSen: 30000,
    tree: [
      { kind: 'category', id: 'cf:in', label: 'CASH IN', flow: 'in', totalLabel: 'Total Cash In', amountSen: 50000, pct: 100, cells: { '310-0010': 50000 }, children: [
        { kind: 'category', id: 'cf:in:sales', label: 'Sales & trade receipts', amountSen: 50000, pct: 100, cells: { '310-0010': 50000 }, children: [
          { ...acc('300-0000', '300-0000 · AR', 50000, 100), id: 'in:acc:300-0000', flow: 'in', cells: { '310-0010': 50000 } },
        ] },
      ] },
      { kind: 'category', id: 'cf:ops', label: 'OPERATIONS OUTFLOWS', flow: 'out', totalLabel: 'Total operations outflows', amountSen: 30000, pct: 100, cells: { '310-0010': 30000 }, children: [
        { ...acc('900-S100', '900-S100 · SALARIES', 30000, 100), id: 'out:acc:900-S100', flow: 'out', cells: { '310-0010': 30000 } },
      ] },
      { kind: 'subtotal', id: 'cf:sub:ops', label: 'Net operation surplus / (deficit)', amountSen: 20000, pct: null, cells: { '310-0010': 20000 }, children: [] },
    ],
  },
};

describe('the Cash Flow as a table', () => {
  it('lays each top category as a block with its tree and its own subtotal name, a running subtotal as a net line, then Cash Surplus, Balance b/f and c/f — Total and % alone when nothing is ticked', () => {
    const t = cashFlowTable(rp);
    expect(t.columns.map((c) => c.label)).toEqual(['Total', '%']);
    expect(t.rows.map((r) => [r.kind, r.depth, r.label])).toEqual([
      ['block', 0, 'CASH IN'], ['category', 1, 'Sales & trade receipts'], ['row', 2, '300-0000 · AR'], ['total', 0, 'Total Cash In'],
      ['block', 0, 'OPERATIONS OUTFLOWS'], ['row', 1, '900-S100 · SALARIES'], ['total', 0, 'Total operations outflows'],
      ['net', 0, 'Net operation surplus / (deficit)'],
      ['net', 0, 'Cash Surplus / (Deficit)'], ['total', 0, 'Balance b/f'], ['net', 0, 'Balance c/f'],
    ]);
    expect(t.rows[2]!.cells).toEqual([50000, 100]);
    expect(t.rows[7]!.cells).toEqual([20000, null]);
    expect(t.rows[9]!.cells).toEqual([-10000, null]);
    expect(t.rows[10]!.cells).toEqual([10000, null]);
  });

  it('carries the ticked columns before Total — a zero there is a dash, as on the screen — and folds to the level', () => {
    const t = cashFlowTable(rp, { columns: ['320-0000', '310-0010'], level: 1 });
    expect(t.columns.map((c) => c.label)).toEqual(['310-0010 BANK', '320-0000 CASH', 'Total', '%']);
    expect(t.rows.map((r) => r.label)).toEqual(['CASH IN', 'Sales & trade receipts', 'Total Cash In', 'OPERATIONS OUTFLOWS', '900-S100 · SALARIES', 'Total operations outflows', 'Net operation surplus / (deficit)', 'Cash Surplus / (Deficit)', 'Balance b/f', 'Balance c/f']);
    expect(t.rows[1]!.cells).toEqual([50000, null, 50000, 100]);
    expect(t.rows[8]!.cells).toEqual([-10000, null, -10000, null]);
    /* A hand-opened category shows its rows past the level, as on the screen. */
    expect(cashFlowTable(rp, { level: 1, open: { 'cf:in:sales': true } }).rows.map((r) => r.label)).toContain('300-0000 · AR');
  });
});

const perf: PerformanceReport = {
  from: '2026-07-01', to: '2026-07-31',
  orders: { counted: 4, notDelivered: 3, excludedDraft: 1, excludedCancelled: 1 },
  groups: [
    { key: 'sofa', label: 'Sofa', lines: 1, salesSen: 300000, cogsSen: 180000, gpSen: 120000, gpPct: 40 },
    { key: 'accessory', label: 'Accessory', lines: 1, salesSen: 0, cogsSen: 12000, gpSen: -12000, gpPct: null },
  ],
  totals: { salesSen: 300000, cogsSen: 192000, gpSen: 108000, gpPct: 36, salesExServiceSen: 300000 },
  operatingExpense: { rateBp: 1600, baseSen: 300000, amountSen: 48000, account: '900-O001', accountName: 'OPERATIING EXPENSE', accountFound: true, bookedSen: 0 },
  otherIncome: [], otherIncomeSen: 0,
  otherExpenses: [{ code: '900-R048', name: 'RENTAL OF SHOWROOM', amountSen: 450000 }], otherExpensesSen: 450000,
  netSen: 108000 - 48000 - 450000, netPct: -130,
  settings: { rateBp: 1600, account: '900-O001' },
  layout: {
    stored: true, baseSen: 300000,
    otherIncome: [],
    expenses: [{ kind: 'category', id: 'cat:fixed', label: 'Fixed costs', amountSen: 498000, pct: 166, children: [
      acc('900-R048', '900-R048 · RENTAL OF SHOWROOM', 450000, 150),
      acc('900-O001', 'Operating expense — 16.00% of sales, in place of 900-O001', 48000, 16),
    ] }],
  },
};

describe('the Performance P&L as tables', () => {
  it('lays the groups with their total, then the summary folded to the level, and the notes', () => {
    const { tables, notes } = performanceTables(perf, { level: 1 });
    expect(tables[0]!.columns.map((c) => [c.label, c.kind])).toEqual([['Sales', 'amount'], ['Cost of sales', 'amount'], ['Gross profit', 'amount'], ['GP %', 'pct']]);
    expect(tables[0]!.rows).toEqual([
      { kind: 'row', depth: 0, label: 'Sofa', cells: [300000, 180000, 120000, 40] },
      { kind: 'row', depth: 0, label: 'Accessory', cells: [0, 12000, -12000, null] },
      { kind: 'total', depth: 0, label: 'Total', cells: [300000, 192000, 108000, 36] },
    ]);
    expect(tables[1]!.columns.map((c) => c.label)).toEqual(['Amount', '% of sales']);
    expect(tables[1]!.rows.map((r) => [r.kind, r.depth, r.label])).toEqual([
      ['total', 0, 'Gross profit'], ['total', 0, 'Total other income (as booked)'], ['category', 1, 'Fixed costs'],
      ['total', 0, 'Total expenses (operating expense at 16.00% + as booked)'], ['net', 0, 'NET PERFORMANCE'],
    ]);
    expect(performanceTables(perf).tables[1]!.rows.map((r) => r.label)).toContain('900-R048 · RENTAL OF SHOWROOM');
    expect(notes.length).toBeGreaterThan(0);
  });
});

describe('the monthly grid as a table', () => {
  const columns: MonthColumn[] = [
    { key: 'cumulative', label: '累计 08/2026 – 09/2026', from: '2026-08-01', to: '2026-09-30', cumulative: true },
    { key: '2026-09', label: '09/2026', from: '2026-09-01', to: '2026-09-30', cumulative: false },
    { key: '2026-08', label: '08/2026', from: '2026-08-01', to: '2026-08-31', cumulative: false },
  ];
  const shown: MonthlyLine[] = [
    { id: 'blk', label: 'Expenses', kind: 'block', depth: 0, cells: {} },
    { id: 'rent', label: 'RENT', kind: 'row', depth: 1, code: '900-R044', cells: { cumulative: { amountSen: 200_000, pct: 20 }, '2026-09': { amountSen: 100_000, pct: 25 }, '2026-08': { amountSen: 100_000, pct: 40 } } },
    { id: 'advert', label: 'ADVERT', kind: 'row', depth: 1, cells: { cumulative: { amountSen: 5_000, pct: 0.5 }, '2026-08': { amountSen: 5_000, pct: 2 } } },
    { id: 'tot', label: 'Total expenses', kind: 'total', depth: 0, cells: { cumulative: { amountSen: 205_000, pct: 20.5 }, '2026-09': { amountSen: 100_000, pct: 25 }, '2026-08': { amountSen: 105_000, pct: 42 } } },
  ];
  it('in amounts mode every month is an amount with its % beside it; 累计 wears the edge; a month a line never had is a dash in both slots', () => {
    const t = monthlyTable(columns, shown, false);
    expect(t.columns).toEqual([
      { label: '累计 08/2026 – 09/2026', kind: 'amount' }, { label: '%', kind: 'pct', beside: true, edge: true },
      { label: '09/2026', kind: 'amount' }, { label: '%', kind: 'pct', beside: true, edge: false },
      { label: '08/2026', kind: 'amount' }, { label: '%', kind: 'pct', beside: true, edge: false },
    ]);
    expect(t.rows[0]).toEqual({ kind: 'block', depth: 0, label: 'Expenses', cells: [] });
    expect(t.rows[1]!.cells).toEqual([200_000, 20, 100_000, 25, 100_000, 40]);
    expect(t.rows[2]!.cells).toEqual([5_000, 0.5, null, null, 5_000, 2]);
    expect(t.rows[3]).toMatchObject({ kind: 'total', cells: [205_000, 20.5, 100_000, 25, 105_000, 42] });
  });
  it('in % mode every month is its % alone', () => {
    const t = monthlyTable(columns, shown, true);
    expect(t.columns).toEqual([
      { label: '累计 08/2026 – 09/2026', kind: 'pct', edge: true }, { label: '09/2026', kind: 'pct', edge: false }, { label: '08/2026', kind: 'pct', edge: false },
    ]);
    expect(t.rows[2]!.cells).toEqual([0.5, null, 2]);
  });
});
