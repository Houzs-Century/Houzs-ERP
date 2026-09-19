/* The Performance P&L's exports carry the sheet the screen shows (docs/bugs/0835;
   owner 2026-09-19: 显示什么就 export 什么) — pure here: the sheet's title, period,
   letterhead lines, the two tables and the notes; the tables' cells are
   report-sheet.test.ts. */
import { describe, expect, it } from 'vitest';
import { performanceSheet } from './performance-pnl-pdf';
import { fmtPerf, performanceNotes, type PerformanceReport } from './performance-report-queries';
import type { LaidNode } from './report-layout';

const acc = (code: string, label: string, amountSen: number, pct: number | null): LaidNode =>
  ({ kind: 'account', id: `acc:${code}`, label, code, key: code, amountSen, pct, children: [] });

const r: PerformanceReport = {
  from: '2026-07-01', to: '2026-07-31',
  orders: { counted: 4, notDelivered: 3, excludedDraft: 1, excludedCancelled: 1 },
  groups: [
    { key: 'bedframe', label: 'Bedframe', lines: 1, salesSen: 50000, cogsSen: 20000, gpSen: 30000, gpPct: 60 },
    { key: 'sofa', label: 'Sofa', lines: 1, salesSen: 300000, cogsSen: 180000, gpSen: 120000, gpPct: 40 },
    { key: 'accessory', label: 'Accessory', lines: 1, salesSen: 0, cogsSen: 12000, gpSen: -12000, gpPct: null },
    { key: 'service', label: 'Service / transport income', lines: 1, salesSen: 23000, cogsSen: 0, gpSen: 23000, gpPct: 100 },
  ],
  totals: { salesSen: 373000, cogsSen: 212000, gpSen: 161000, gpPct: 43.2, salesExServiceSen: 350000 },
  operatingExpense: { rateBp: 1600, baseSen: 350000, amountSen: 56000, account: '900-O001', accountName: 'OPERATIING EXPENSE', accountFound: true, bookedSen: 243550 },
  otherIncome: [{ code: '590-0000', name: 'RENT RECEIVED', amountSen: 50000 }],
  otherIncomeSen: 50000,
  otherExpenses: [{ code: '900-R048', name: 'RENTAL OF SHOWROOM', amountSen: 4500000 }],
  otherExpensesSen: 4500000,
  netSen: 161000 + 50000 - 56000 - 4500000, netPct: -1164.9,
  settings: { rateBp: 1600, account: '900-O001' },
  layout: {
    stored: false, baseSen: 373000,
    otherIncome: [{ kind: 'category', id: 'sec:OTHER INCOMES', label: 'OTHER INCOMES', amountSen: 50000, pct: 13.4, children: [acc('590-0000', '590-0000 · RENT RECEIVED', 50000, 13.4)] }],
    expenses: [
      acc('900-O001', 'Operating expense — 16.00% of sales excluding service (3,500.00), in place of 900-O001 OPERATIING EXPENSE', 56000, 15),
      acc('900-R048', '900-R048 · RENTAL OF SHOWROOM', 4500000, 1206.4),
    ],
  },
};

describe('performanceSheet', () => {
  it('names the report, its period and its orders; the groups table then the summary; the notes at the foot', () => {
    const s = performanceSheet(r);
    expect(s.title).toBe('Performance P&L');
    expect(s.subtitle).toBe('Sales orders dated 01/07/2026 – 31/07/2026 · 4 orders, 3 not yet delivered · % of sales');
    expect(s.meta).toEqual([{ label: 'Period', value: '01/07/2026 – 31/07/2026' }, { label: 'Orders', value: '4 (3 not yet delivered)' }]);
    expect(s.tables).toHaveLength(2);
    expect(s.tables[0]!.rows.map((x) => x.label)).toEqual(['Bedframe', 'Sofa', 'Accessory', 'Service / transport income', 'Total']);
    expect(s.tables[0]!.rows[2]!.cells).toEqual([0, 12000, -12000, null]);
    expect(s.tables[0]!.rows[4]).toMatchObject({ kind: 'total', cells: [373000, 212000, 161000, 43.2] });
    /* The account part is the report's tree (docs/bugs/0912): a category with its subtotal, its rows a level deeper. */
    expect(s.tables[1]!.rows.map((x) => [x.kind, x.depth, x.label])).toEqual([
      ['total', 0, 'Gross profit'],
      ['category', 1, 'OTHER INCOMES'],
      ['row', 2, '590-0000 · RENT RECEIVED'],
      ['total', 0, 'Total other income (as booked)'],
      ['row', 1, 'Operating expense — 16.00% of sales excluding service (3,500.00), in place of 900-O001 OPERATIING EXPENSE'],
      ['row', 1, '900-R048 · RENTAL OF SHOWROOM'],
      ['total', 0, 'Total expenses (operating expense at 16.00% + as booked)'],
      ['net', 0, 'NET PERFORMANCE'],
    ]);
    /* SIGNS (docs/bugs/0910): an expense is the positive figure it is. */
    expect(s.tables[1]!.rows[4]!.cells).toEqual([56000, 15]);
    expect(s.tables[1]!.rows[7]!.cells).toEqual([-4345000, -1164.9]);
    expect(s.notes).toEqual(performanceNotes(r));
    expect(s.fmt).toBe(fmtPerf);
    /* L1 folds the category's rows away, as on the screen. */
    expect(performanceSheet(r, { level: 1 }).tables[1]!.rows.map((x) => x.label)).not.toContain('590-0000 · RENT RECEIVED');
  });

  it('the notes say where each side came from and what the rate replaced', () => {
    const notes = performanceNotes(r);
    expect(notes[0]).toContain('sales orders dated 01/07/2026 to 31/07/2026');
    expect(notes[0]).toContain('4 orders, 3 of them not yet delivered');
    expect(notes[1]).toContain('16.00% of sales excluding service / transport income (3,500.00), in place of account 900-O001 OPERATIING EXPENSE');
    expect(notes[1]).toContain('the 2,435.50 booked on that account in the period is left out. Other income and every other expense are as booked');
    expect(notes[2]).toContain('free gifts');
    const missing = performanceNotes({ ...r, operatingExpense: { ...r.operatingExpense, accountFound: false, accountName: null, bookedSen: 0 } });
    expect(missing[1]).toContain('Account 900-O001 is not in this company\'s chart, so nothing was replaced');
  });

  it('fmtPerf brackets a negative and keeps the thousands', () => {
    expect(fmtPerf(123456)).toBe('1,234.56');
    expect(fmtPerf(-5)).toBe('(0.05)');
  });
});
