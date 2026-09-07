/* The printed Receipts & Payments table is the screen's table — pure, so this
   reads the cells without rendering a PDF. */
import { describe, expect, it } from 'vitest';
import { fmtRp, rpTable } from './rp-report-pdf';
import type { RpReport } from './rp-report-queries';

const r: RpReport = {
  from: '2026-07-01', to: '2026-07-31', byParty: false,
  columns: [{ code: '310-0010', name: 'BANK' }],
  opening: { '310-0010': -10000 },
  receipts: [{ key: '300-0000', code: '300-0000', name: 'AR', cells: { '310-0010': 50000 }, totalSen: 50000 }],
  payments: [{ key: 'ADV', code: null, name: 'Supplier advances (预付)', cells: { '310-0010': 30000 }, totalSen: 30000 }],
  totals: { receipts: { '310-0010': 50000 }, payments: { '310-0010': 30000 }, closing: { '310-0010': 10000 }, openingTotalSen: -10000, receiptsTotalSen: 50000, paymentsTotalSen: 30000, closingTotalSen: 10000 },
  entries: [],
};

describe('rpTable', () => {
  it('lays the four balance lines around the two sections, one column per account plus Total', () => {
    const t = rpTable(r);
    expect(t.head).toEqual(['', '310-0010\nBANK', 'Total']);
    expect(t.lines.map((l) => l.label)).toEqual(['Opening balance', 'RECEIPTS', '300-0000 · AR', 'Total receipts', 'PAYMENTS', 'Supplier advances (预付)', 'Total payments', 'Closing balance']);
    expect(t.lines[0]!.cells).toEqual(['(100.00)', '(100.00)']);
    expect(t.lines[7]!.cells).toEqual(['100.00', '100.00']);
  });

  it('fmtRp brackets a negative and keeps the thousands', () => {
    expect(fmtRp(123456)).toBe('1,234.56');
    expect(fmtRp(-5)).toBe('(0.05)');
  });
});
