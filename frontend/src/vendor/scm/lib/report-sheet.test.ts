/* The report sheet — a Finance report as the screen shows it, the one shape
   Excel and PDF draw (owner 2026-09-19: 我这页显示什么就要 export 什么). Pinned:
   a statement's lines as rows of amount and %; the Cash Flow with the ticked
   columns, folded to the level, a zero in an account column a dash; the
   monthly grid in amounts mode
   (a % beside each amount) and in % mode; a cell's text. */
import { describe, expect, it } from 'vitest';
import type { LaidNode } from './report-layout';
import type { FlatLine, MonthColumn, MonthlyLine } from './report-monthly';
import type { RpReport } from './rp-report-queries';
import { cashFlowTable, exportFileName, monthlyTable, rowsWithTotalsBelow, sheetText, statementColumnsTable, statementTable } from './report-sheet';

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
  card: { takingsSen: 0, transitSen: 0, codes: [] },
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
  it('lays each top category as a block with its tree and its own subtotal name, a running subtotal as a net line, then Cash surplus / (deficit) with its % of the receipts, Balance b/f and c/f — Total and % alone when nothing is ticked', () => {
    const t = cashFlowTable(rp, { codes: true });
    expect(t.columns.map((c) => c.label)).toEqual(['Total', '%']);
    expect(t.rows.map((r) => [r.kind, r.depth, r.label])).toEqual([
      ['block', 0, 'CASH IN'], ['category', 1, 'Sales & trade receipts'], ['row', 2, '300-0000 · AR'], ['total', 0, 'Total Cash In'],
      ['block', 0, 'OPERATIONS OUTFLOWS'], ['row', 1, '900-S100 · SALARIES'], ['total', 0, 'Total operations outflows'],
      ['net', 0, 'Net operation surplus / (deficit)'],
      ['net', 0, 'Cash surplus / (deficit)'], ['total', 0, 'Balance b/f'], ['net', 0, 'Balance c/f'],
    ]);
    expect(t.rows[2]!.cells).toEqual([50000, 100]);
    expect(t.rows[7]!.cells).toEqual([20000, null]);
    expect(t.rows[9]!.cells).toEqual([-10000, null]);
    expect(t.rows[10]!.cells).toEqual([10000, null]);
    expect(t.rows[8]!.cells).toEqual([20000, 40]);
    const plain = cashFlowTable(rp, { pct: false, codes: true });
    expect(plain.columns.map((c) => c.label)).toEqual(['Total']);
    expect(plain.rows[8]!.cells).toEqual([20000]);
  });

  it('carries the ticked columns before Total — a zero there is a dash, as on the screen — and folds to the level', () => {
    const t = cashFlowTable(rp, { columns: ['320-0000', '310-0010'], level: 1, codes: true });
    expect(t.columns.map((c) => c.label)).toEqual(['310-0010 BANK', '320-0000 CASH', 'Total', '%']);
    expect(t.rows.map((r) => r.label)).toEqual(['CASH IN', 'Sales & trade receipts', 'Total Cash In', 'OPERATIONS OUTFLOWS', '900-S100 · SALARIES', 'Total operations outflows', 'Net operation surplus / (deficit)', 'Cash surplus / (deficit)', 'Balance b/f', 'Balance c/f']);
    expect(t.rows[1]!.cells).toEqual([50000, null, 50000, 100]);
    expect(t.rows[8]!.cells).toEqual([-10000, null, -10000, null]);
    expect(cashFlowTable(rp, { level: 1, open: { 'cf:in:sales': true }, codes: true }).rows.map((r) => r.label)).toContain('300-0000 · AR');
  });
});

describe('the monthly grid as a table', () => {
  const columns: MonthColumn[] = [
    { key: 'cumulative', label: 'Cumulative 08/2026 – 09/2026', from: '2026-08-01', to: '2026-09-30', cumulative: true },
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
      { label: 'Cumulative 08/2026 – 09/2026', kind: 'amount' }, { label: '%', kind: 'pct', beside: true, edge: true },
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
      { label: 'Cumulative 08/2026 – 09/2026', kind: 'pct', edge: true }, { label: '09/2026', kind: 'pct', edge: false }, { label: '08/2026', kind: 'pct', edge: false },
    ]);
    expect(t.rows[2]!.cells).toEqual([0.5, null, 2]);
  });
});

describe('the Cash Flow\'s Settlement / Deposit columns as a table (owner 2026-11-09)', () => {
  const columns = [
    { key: 'total', label: 'Total', pct: true, edge: true },
    { key: '2026-10:S', label: 'Settlement', pct: false, group: 'Oct 2026' },
    { key: '2026-10:D', label: 'Deposit', pct: false, group: 'Oct 2026' },
  ];
  const shown: MonthlyLine[] = [
    { id: 'in', label: 'DEPOSIT RECEIVED', kind: 'category', depth: 1, cells: { total: { amountSen: 90_000, pct: 100 }, '2026-10:S': { amountSen: 50_000, pct: null }, '2026-10:D': { amountSen: 40_000, pct: null } } },
    { id: 'a', label: '300-0000', kind: 'row', depth: 2, cells: { total: { amountSen: 90_000, pct: 100 }, '2026-10:S': { amountSen: 50_000, pct: null }, '2026-10:D': { amountSen: 40_000, pct: null } } },
    { id: 'tax', label: 'TAXATION', kind: 'row', depth: 1, cells: { total: { amountSen: 5_000, pct: 2.5 }, '2026-10:S': { amountSen: 5_000, pct: null } }, spans: { '2026-10:S': 2 } },
  ];
  it('a column keeps its heading; a line not split runs one cell across the month, the covered cell left empty', () => {
    const t = statementColumnsTable(columns, shown);
    expect(t.columns).toEqual([
      { label: 'Total', kind: 'amount' }, { label: '%', kind: 'pct', beside: true, edge: true },
      { label: 'Settlement', kind: 'amount', group: 'Oct 2026' }, { label: 'Deposit', kind: 'amount', group: 'Oct 2026' },
    ]);
    expect(t.rows[0]!.cells).toEqual([90_000, 100, 50_000, 40_000]);
    expect(t.rows[0]!.spans).toBeUndefined();
    expect(t.rows[2]).toMatchObject({ cells: [5_000, 2.5, 5_000, ''], spans: { 2: 2 } });
  });
  it('an open group\'s merged cells move with its figures to its Total row; its bare title has none', () => {
    const rows = rowsWithTotalsBelow([
      { kind: 'category', depth: 1, label: 'OTHER', cells: [5, null, 5, null], spans: { 2: 2 } },
      { kind: 'row', depth: 2, label: 'x', cells: [3, null, 3, null], spans: { 2: 2 } },
      { kind: 'row', depth: 2, label: 'y', cells: [2, null, 2, null], spans: { 2: 2 } },
    ]);
    expect(rows[0]).toEqual({ kind: 'category', depth: 1, label: 'OTHER', cells: [] });
    expect(rows[3]).toEqual({ kind: 'total', depth: 1, label: 'Total OTHER', cells: [5, null, 5, null], spans: { 2: 2 } });
  });
  it('as the screen (owner 2026-11-27): no Total row repeating the one row under its group', () => {
    const rows = rowsWithTotalsBelow([
      { kind: 'category', depth: 1, label: 'COST OF FUNDS', cells: [900, 10] },
      { kind: 'category', depth: 2, label: 'PURCHASES', cells: [900, 10] },
      { kind: 'row', depth: 3, label: 'p1', cells: [600, 7] },
      { kind: 'row', depth: 3, label: 'p2', cells: [300, 3] },
      { kind: 'category', depth: 1, label: 'COMMISSION', cells: [100, 1] },
      { kind: 'row', depth: 2, label: 'c1', cells: [100, 1] },
      { kind: 'category', depth: 1, label: 'RADIUS', cells: [250, 2] },
      { kind: 'row', depth: 2, label: 'x1', cells: [200, 2] },
    ]);
    expect(rows.map((r) => r.label)).toEqual(['COST OF FUNDS', 'PURCHASES', 'p1', 'p2', 'Total PURCHASES', 'COMMISSION', 'c1', 'RADIUS', 'x1', 'Total RADIUS']);
  });
  it('a cell with nothing is blank, as on the screen (owner 2026-11-27)', () => {
    const t = statementColumnsTable([{ key: 'total', label: 'Total', pct: true }, { key: '2026-10', label: 'Oct 2026', pct: false }],
      [{ id: 'a', label: '900-A001 · ADVERT', kind: 'row', depth: 1, code: '900-A001', cells: { total: { amountSen: 500, pct: 5 } } }]);
    expect(t.rows[0]!.cells).toEqual([500, 5, '']);
  });
  it('codes off: an account prints its name alone, on the Cash Flow as on the screen', () => {
    expect(cashFlowTable(rp, { level: 1, open: { 'cf:in:sales': true }, codes: false }).rows.map((r) => r.label)).toContain('AR');
  });
});
