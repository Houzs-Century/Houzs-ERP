import { describe, expect, it } from 'vitest';
import { piAmounts, type BillLine, type PiReview, type PiReviewLine } from './scan-pi-check';

const bill = (grnItemId: string, unitPriceSen: number): BillLine => ({ supplierSku: null, grnItemId, grnNumber: 'GRN-1', supplierId: 's', poNumber: 'PO-1', itemCode: 'X', description: null, remaining: 9, unitPriceSen });
const row = (key: string, grnItemId: string | null, qty: number, read: PiReviewLine['read']): PiReviewLine => ({ key, grnItemId, grnNumber: null, qty, suggested: false, read });
const review = (lines: PiReviewLine[]): PiReview => ({ v: 1, supplierId: 's', supplierRead: null, invoiceNumber: 'I', invoiceDate: null, doNo: null, poNo: null, notes: null, taxNote: null, lines });
const read = (unitPrice: number | null, lineTotal: number | null) => ({ itemCode: null, description: null, qty: 1, unitPrice, lineTotal });
const lines = new Map([['a', bill('a', 80_000)], ['b', bill('b', 20_000)]]);

describe('piAmounts', () => {
  it('adds what the invoice printed beside the same rows at our price', () => {
    const r = review([row('1', 'a', 2, read(830, 1660)), row('2', 'b', 1, read(200, null))]);
    expect(piAmounts(r, lines)).toEqual({ invoiceSen: 186_000, oursSen: 180_000 });
  });

  it('leaves our amount empty until every row is tied, so a part is not read as the whole', () => {
    const r = review([row('1', 'a', 2, read(830, 1660)), row('2', null, 1, read(200, 200))]);
    expect(piAmounts(r, lines)).toEqual({ invoiceSen: 186_000, oursSen: null });
  });

  it('leaves the invoice amount empty when a row printed no price', () => {
    expect(piAmounts(review([row('1', 'a', 2, read(null, null))]), lines).invoiceSen).toBeNull();
  });
});
