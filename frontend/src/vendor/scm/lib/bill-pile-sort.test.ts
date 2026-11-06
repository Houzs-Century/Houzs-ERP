import { describe, expect, it } from 'vitest';
import type { BillExtraction, ExtractedBill } from './payment-voucher-queries';
import { isNotABill, repeatsOf, voucherLinesOf } from './bill-pile-sort';

const ex = (over: Partial<BillExtraction>): BillExtraction => ({
  vendorName: null, vendorRegNo: null, documentKind: 'receipt', invoiceNumber: null, invoiceDate: null, dueDate: null,
  currency: 'MYR', totalSen: null, sstSen: null, lines: [], ...over,
});
const bill = (index: number, over: Partial<BillExtraction>) =>
  ({ index, ok: true, extraction: ex(over), supplierMatch: null, memory: null }) as Extract<ExtractedBill, { ok: true }>;

describe('bill-pile-sort', () => {
  it('a payment slip and a summary are not bills; a statement still is', () => {
    expect(isNotABill(ex({ documentKind: 'payment_proof' }))).toBe(true);
    expect(isNotABill(ex({ documentKind: 'summary' }))).toBe(true);
    expect(isNotABill(ex({ documentKind: 'statement' }))).toBe(false);
  });

  it('a repeat is the same number at the same total; no number or no total repeats nothing', () => {
    const r = repeatsOf([
      bill(0, { invoiceNumber: 'A-AX44', totalSen: 3144 }),
      bill(1, { invoiceNumber: 'a ax44', totalSen: 3144 }),
      bill(2, { invoiceNumber: 'A-AX44', totalSen: 999 }),
      bill(3, { invoiceNumber: null, totalSen: 1000 }),
      bill(4, { invoiceNumber: null, totalSen: 1000 }),
    ]);
    expect([...r.entries()]).toEqual([[1, 0]]);
  });

  it('a page of several purchases gives a line each; one receipt gives one line at its total', () => {
    const lines = [{ description: 'Mugs', amountSen: 2373 }, { description: 'Lamp', amountSen: 3405 }];
    expect(voucherLinesOf(ex({ severalReceipts: true, totalSen: 5778, lines }), 'X')).toEqual(lines);
    expect(voucherLinesOf(ex({ totalSen: 5778, lines }), 'X')).toEqual([{ description: 'Mugs · Lamp', amountSen: 5778 }]);
    expect(voucherLinesOf(ex({ totalSen: 100 }), 'SHOP 1')).toEqual([{ description: 'SHOP 1', amountSen: 100 }]);
  });
});
