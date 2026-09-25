/* The Cash Flow's exports carry the sheet the screen shows (owner
   2026-09-19: 显示什么就 export 什么) — pure here: the sheet's title, period,
   letterhead lines and money dress; the table itself is report-sheet.test.ts. */
import { describe, expect, it } from 'vitest';
import { cashFlowSheet, fmtRp } from './rp-report-pdf';
import type { RpReport } from './rp-report-queries';

const r: RpReport = {
  from: '2026-07-01', to: '2026-07-31', byParty: false,
  columns: [{ code: '310-0010', name: 'BANK' }],
  opening: { '310-0010': -10000 },
  receipts: [{ key: '300-0000', code: '300-0000', name: 'AR', cells: { '310-0010': 50000 }, totalSen: 50000 }],
  payments: [{ key: 'ADV', code: null, name: 'Supplier advances (预付)', cells: { '310-0010': 30000 }, totalSen: 30000 }],
  totals: { receipts: { '310-0010': 50000 }, payments: { '310-0010': 30000 }, closing: { '310-0010': 10000 }, openingTotalSen: -10000, receiptsTotalSen: 50000, paymentsTotalSen: 30000, closingTotalSen: 10000 },
  entries: [],
  layout: {
    stored: false, inSen: 50000, outSen: 30000,
    tree: [
      { kind: 'category', id: 'side:in', label: 'RECEIPTS', flow: 'in', totalLabel: 'Total receipts', amountSen: 50000, pct: 100, cells: { '310-0010': 50000 }, children: [
        { kind: 'account', id: 'in:acc:300-0000', label: '300-0000 · AR', code: '300-0000', key: '300-0000', flow: 'in', amountSen: 50000, pct: 100, cells: { '310-0010': 50000 }, children: [] },
      ] },
      { kind: 'category', id: 'side:out', label: 'PAYMENTS', flow: 'out', totalLabel: 'Total payments', amountSen: 30000, pct: 100, cells: { '310-0010': 30000 }, children: [
        { kind: 'account', id: 'out:acc:ADV', label: 'Supplier advances (预付)', code: 'ADV', key: 'ADV', flow: 'out', amountSen: 30000, pct: 100, cells: { '310-0010': 30000 }, children: [] },
      ] },
    ],
  },
};

describe('cashFlowSheet', () => {
  it('names the report, its period and its rows; Total alone when nothing is ticked, the ticked column before Total otherwise', () => {
    const s = cashFlowSheet(r);
    expect(s.title).toBe('Cash Flow');
    expect(s.subtitle).toBe("2026/07/01 – 2026/07/31 · every bank and cash account · by the owner's accounts · % of the side's total");
    expect(s.meta).toEqual([
      { label: 'Period', value: '2026/07/01 – 2026/07/31' },
      { label: 'Accounts', value: '310-0010' },
      { label: 'Rows', value: "By the owner's accounts" },
    ]);
    expect(s.tables[0]!.columns.map((c) => c.label)).toEqual(['Total', '%']);
    expect(s.tables[0]!.rows.map((x) => [x.kind, x.label])).toEqual([
      ['block', 'RECEIPTS'], ['row', '300-0000 · AR'], ['total', 'Total receipts'],
      ['block', 'PAYMENTS'], ['row', 'Supplier advances (预付)'], ['total', 'Total payments'],
      ['net', 'Cash Surplus / (Deficit)'], ['total', 'Balance b/f'], ['net', 'Balance c/f'],
    ]);
    expect(cashFlowSheet(r, { columns: ['310-0010'] }).tables[0]!.columns.map((c) => c.label)).toEqual(['310-0010 BANK', 'Total', '%']);
    expect(cashFlowSheet({ ...r, byParty: true }).meta[2]).toEqual({ label: 'Rows', value: 'By debtor / creditor' });
    expect(s.fmt).toBe(fmtRp);
  });

  it('fmtRp brackets a negative and keeps the thousands', () => {
    expect(fmtRp(123456)).toBe('1,234.56');
    expect(fmtRp(-5)).toBe('(0.05)');
  });
});
