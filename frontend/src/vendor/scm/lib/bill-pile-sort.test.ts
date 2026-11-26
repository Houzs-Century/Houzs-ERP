import { describe, expect, it } from 'vitest';
import type { BillExtraction, ExtractedBill } from './payment-voucher-queries';
import { claimEvidenceOf, isClaimForm, isNotABill, repeatsOf, voucherLinesOf } from './bill-pile-sort';

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

  /* Owner 2026-11-16 (已经有 claim form 还是会读错就不应该): Elise's claim form —
     16 rows, RM 5,494.66, its receipts behind it — was set aside as a listing. */
  it('a claim form whose rows add up to its total is the claim; a listing without them is not', () => {
    const rows = [{ description: '21 Oct IKEA Table Lamp', amountSen: 166915 }, { description: '21 Oct Haier Dust Mite Vacuum', amountSen: 35488 }];
    const form = ex({ documentKind: 'summary', totalSen: 202403, lines: rows });
    expect(isClaimForm(form)).toBe(true);
    expect(isNotABill(form)).toBe(false);
    expect(voucherLinesOf(form, 'X')).toEqual(rows);
    const short = ex({ documentKind: 'summary', totalSen: 202403, lines: [rows[0]!, { description: 'Haier', amountSen: null }] });
    expect(isClaimForm(short)).toBe(false);
    expect(isNotABill(short)).toBe(true);
    expect(isClaimForm(ex({ documentKind: 'summary', totalSen: 342729 }))).toBe(false);
    expect(isClaimForm(ex({ documentKind: 'receipt', totalSen: 202403, lines: rows }))).toBe(false);
  });

  it("a claim form's rows take the receipts at their amounts; its file's other pages go with it; other files' receipts stay", () => {
    const form = bill(0, { documentKind: 'summary', totalSen: 55524, lines: [
      { description: 'Vacuum', amountSen: 35488 }, { description: 'Soundbar', amountSen: 15036 }, { description: 'Lamp', amountSen: 5000 },
    ] });
    const source: Record<number, string> = { 0: 'elise', 1: 'elise', 2: 'elise', 3: 'elise', 4: 'tnb', 5: 'shop' };
    const ev = claimEvidenceOf([
      form,
      bill(1, { totalSen: 15036 }),
      bill(2, { totalSen: 35488 }),
      bill(3, { totalSen: 999 }),
      bill(4, { totalSen: 12000 }),
      bill(5, { totalSen: 5000 }),
    ], (i) => source[i]!);
    expect([...ev.entries()].sort(([a], [b]) => a - b)).toEqual([
      [1, { claim: 0, row: 2 }],
      [2, { claim: 0, row: 1 }],
      [3, { claim: 0, row: null }],
      [5, { claim: 0, row: 3 }],
    ]);
    expect(claimEvidenceOf([bill(1, { totalSen: 15036 }), bill(2, { totalSen: 15036 })], () => 'same').size).toBe(0);
  });
});
