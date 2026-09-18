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
  layout: {
    stored: false,
    receipts: [{ kind: 'category', id: 'sec:CURRENT ASSETS', label: 'CURRENT ASSETS', amountSen: 50000, pct: 100, cells: { '310-0010': 50000 }, children: [
      { kind: 'account', id: 'acc:300-0000', label: '300-0000 · AR', code: '300-0000', key: '300-0000', amountSen: 50000, pct: 100, cells: { '310-0010': 50000 }, children: [] },
    ] }],
    payments: [{ kind: 'account', id: 'acc:ADV', label: 'Supplier advances (预付)', code: 'ADV', key: 'ADV', amountSen: 30000, pct: 100, cells: { '310-0010': 30000 }, children: [] }],
  },
};

describe('rpTable', () => {
  it('lays the four balance lines around the two sections — the rows as the tree, indented, one column per account plus Total and %', () => {
    const t = rpTable(r);
    expect(t.head).toEqual(['', '310-0010\nBANK', 'Total', '%']);
    expect(t.lines.map((l) => [l.kind, l.label])).toEqual([
      ['balance', 'Opening balance'], ['section', 'RECEIPTS'], ['category', 'CURRENT ASSETS'], ['row', '   300-0000 · AR'], ['balance', 'Total receipts'],
      ['section', 'PAYMENTS'], ['row', 'Supplier advances (预付)'], ['balance', 'Total payments'], ['balance', 'Closing balance'],
    ]);
    expect(t.lines[0]!.cells).toEqual(['(100.00)', '(100.00)', '']);
    expect(t.lines[2]!.cells).toEqual(['500.00', '500.00', '100.0%']);
    expect(t.lines[4]!.cells).toEqual(['500.00', '500.00', '100.0%']);
    expect(t.lines[8]!.cells).toEqual(['100.00', '100.00', '']);
  });

  /* The paper follows the screen (owner 2026-09-18: default 看 total): no ticks, Total alone. */
  it('prints only the columns the screen shows — Total alone when nothing is ticked', () => {
    const alone = rpTable(r, []);
    expect(alone.head).toEqual(['', 'Total', '%']);
    expect(alone.lines[0]!.cells).toEqual(['(100.00)', '']);
    expect(alone.lines[2]!.cells).toEqual(['500.00', '100.0%']);
    expect(rpTable(r, ['310-0010']).head).toEqual(rpTable(r).head);
  });

  it('fmtRp brackets a negative and keeps the thousands', () => {
    expect(fmtRp(123456)).toBe('1,234.56');
    expect(fmtRp(-5)).toBe('(0.05)');
  });
});
