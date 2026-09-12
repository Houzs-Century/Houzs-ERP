/* The printed Performance P&L is the screen's tables — pure, so this reads
   the cells without rendering a PDF (docs/bugs/0835). */
import { describe, expect, it } from 'vitest';
import { performanceTables } from './performance-pnl-pdf';
import { fmtPerf, performanceNotes, type PerformanceReport } from './performance-report-queries';

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
  otherExpenses: [{ code: '900-R048', name: 'RENTAL OF SHOWROOM', amountSen: 4500000 }],
  otherExpensesSen: 4500000,
  netSen: 161000 - 56000 - 4500000, netPct: -1178.3,
  settings: { rateBp: 1600, account: '900-O001' },
};

describe('performanceTables', () => {
  it('lays a row per group with GP and %, a Total, then the summary from gross profit to net', () => {
    const t = performanceTables(r);
    expect(t.head).toEqual(['Group', 'Sales', 'Cost of sales', 'Gross profit', 'GP %']);
    expect(t.groups.map((l) => l.cells[0])).toEqual(['Bedframe', 'Sofa', 'Accessory', 'Service / transport income', 'Total']);
    expect(t.groups[1]!.cells).toEqual(['Sofa', '3,000.00', '1,800.00', '1,200.00', '40.0%']);
    expect(t.groups[2]!.cells).toEqual(['Accessory', '0.00', '120.00', '(120.00)', '—']);
    expect(t.groups[4]!).toEqual({ kind: 'total', cells: ['Total', '3,730.00', '2,120.00', '1,610.00', '43.2%'] });
    expect(t.summary.map((l) => l.kind)).toEqual(['total', 'row', 'row', 'total', 'net']);
    expect(t.summary[1]!.label).toBe('Operating expense — 16.00% of sales excluding service (3,500.00), in place of 900-O001 OPERATIING EXPENSE');
    expect(t.summary[1]!.amountSen).toBe(-56000);
    expect(t.summary[2]!.label).toBe('900-R048 · RENTAL OF SHOWROOM');
    expect(t.summary[4]!).toEqual({ kind: 'net', label: 'NET PERFORMANCE', amountSen: -4395000, note: '-1178.3% of sales' });
  });

  it('the notes say where each side came from and what the rate replaced', () => {
    const notes = performanceNotes(r);
    expect(notes[0]).toContain('sales orders dated 01/07/2026 to 31/07/2026');
    expect(notes[0]).toContain('4 orders, 3 of them not yet delivered');
    expect(notes[1]).toContain('16.00% of sales excluding service / transport income (3,500.00), in place of account 900-O001 OPERATIING EXPENSE');
    expect(notes[1]).toContain('the 2,435.50 booked on that account in the period is left out');
    expect(notes[2]).toContain('free gifts');
    const missing = performanceNotes({ ...r, operatingExpense: { ...r.operatingExpense, accountFound: false, accountName: null, bookedSen: 0 } });
    expect(missing[1]).toContain('Account 900-O001 is not in this company\'s chart, so nothing was replaced');
  });

  it('fmtPerf brackets a negative and keeps the thousands', () => {
    expect(fmtPerf(123456)).toBe('1,234.56');
    expect(fmtPerf(-5)).toBe('(0.05)');
  });
});
