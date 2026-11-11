import { describe, expect, it } from 'vitest';
import { isFreeRow, lineTierNote, poRefs, piAmounts, piAmountsDiffer, piQtyTotals, type BillLine, type PiReview, type PiReviewLine } from './scan-pi-check';

const bill = (grnItemId: string, unitPriceSen: number): BillLine => ({ supplierSku: null, grnItemId, grnNumber: 'GRN-1', supplierId: 's', poNumber: 'PO-1', itemCode: 'X', description: null, remaining: 9, unitPriceSen });
const row = (key: string, grnItemId: string | null, qty: number, read: PiReviewLine['read']): PiReviewLine => ({ key, grnItemId, grnNumber: null, qty, suggested: false, read });
const review = (lines: PiReviewLine[]): PiReview => ({ v: 1, supplierId: 's', supplierRead: null, invoiceNumber: 'I', invoiceDate: null, doNo: null, poNo: null, notes: null, taxNote: null, lines });
const read = (unitPrice: number | null, lineTotal: number | null) => ({ itemCode: null, description: null, qty: 1, unitPrice, lineTotal });
const lines = new Map([['a', bill('a', 80_000)], ['b', bill('b', 20_000)]]);

describe('piAmounts', () => {
  it('adds what the invoice printed beside the same rows at our price', () => {
    const r = review([row('1', 'a', 2, read(830, 1660)), row('2', 'b', 1, read(200, null))]);
    expect(piAmounts(r, lines)).toEqual({ invoiceSen: 186_000, oursSen: 180_000, matchedInvoiceSen: 186_000, unmatched: 0 });
  });

  it('INV-2610-027: two rows untied still shows our amount for the rows tied, and how many are not', () => {
    const r = review([row('1', 'a', 2, read(800, 1600)), row('2', null, 1, read(200, 200)), row('3', null, 1, read(50, 50))]);
    const a = piAmounts(r, lines);
    expect(a).toEqual({ invoiceSen: 185_000, oursSen: 160_000, matchedInvoiceSen: 160_000, unmatched: 2 });
    // The tied rows are compared with what the invoice charges for them, not with the whole invoice.
    expect(piAmountsDiffer(a)).toBe(false);
    expect(piAmountsDiffer(piAmounts(review([row('1', 'a', 2, read(830, 1660)), row('2', null, 1, read(200, 200))]), lines))).toBe(true);
  });

  it('no row tied: no amount of ours, nothing to compare', () => {
    const a = piAmounts(review([row('1', null, 1, read(200, 200))]), lines);
    expect(a).toMatchObject({ oursSen: null, unmatched: 1 });
    expect(piAmountsDiffer(a)).toBe(false);
  });

  it('leaves the invoice amount empty when a row printed no price', () => {
    expect(piAmounts(review([row('1', 'a', 2, read(null, null))]), lines).invoiceSen).toBeNull();
  });
});

describe('the invoice amount', () => {
  const row = (unitPrice: number | null, qty: number) => ({ key: String(unitPrice), grnItemId: null, grnNumber: null, qty, suggested: false, read: { itemCode: null, description: 'x', qty, unitPrice, lineTotal: unitPrice == null ? null : unitPrice * qty } });
  const review = (lines: ReturnType<typeof row>[]) => ({ v: 4, supplierId: null, supplierRead: null, invoiceNumber: null, invoiceDate: null, doNo: null, poNo: null, notes: null, taxNote: null, lines });
  it('a free gift with no price leaves the amount standing', () => {
    expect(piAmounts(review([row(1050, 5), row(1300, 1), row(null, 10)]), new Map()).invoiceSen).toBe(655000);
  });
  it('no price read at all stays unknown', () => {
    expect(piAmounts(review([row(null, 10)]), new Map()).invoiceSen).toBeNull();
  });
});

describe('piQtyTotals', () => {
  it('adds the pieces on the paper and what is left on the GRN lines chosen', () => {
    const r = review([row('1', 'a', 2, read(830, 1660)), row('2', 'b', 1, null), row('3', null, 4, read(10, 40))]);
    expect(piQtyTotals(r, lines)).toEqual({ qty: 7, left: 18 });
  });
});

describe('lineTierNote', () => {
  it('says the printed PO\'s lines were used', () => {
    expect(lineTierNote({ lineTier: 'invoice_po', poNo: 'HC-PO-2610-202' })).toBe('Matched to the lines of HC-PO-2610-202 printed on the invoice.');
  });
  it('warns when it fell back to the whole receipt', () => {
    expect(lineTierNote({ lineTier: 'whole_receipt', poNo: 'HC-PO-2610-202' })).toMatch(/No line of HC-PO-2610-202 .* every unbilled line of the receipt/);
  });
  it('says nothing when the invoice printed no PO, or the copy predates the tier', () => {
    expect(lineTierNote({ lineTier: null, poNo: null })).toBeNull();
    expect(lineTierNote({ poNo: 'HC-PO-1' })).toBeNull();
  });
  it('HOOKKA INV-2610-097: names the orders an EX- (exchange) PO replaces, and says what the mark means', () => {
    const note = lineTierNote({ lineTier: 'whole_receipt', poNo: 'EX-PO-009744, EX-HC-PO-2609-151, EX-HC-PO-2609-226' });
    expect(note).toMatch(/^No line of PO-009744, HC-PO-2609-151, HC-PO-2609-226 printed on the invoice matched/);
    expect(note).toMatch(/The invoice marks PO-009744, HC-PO-2609-151, HC-PO-2609-226 as exchange \(EX\): replacement goods for those orders\.$/);
    expect(poRefs('EX HC-PO-1; EXCH-HC-PO-2; HC-PO-3')).toEqual({ refs: ['HC-PO-1', 'HC-PO-2', 'HC-PO-3'], exchange: ['HC-PO-1', 'HC-PO-2'] });
  });
});

describe('a row printed at RM 0 (HOOKKA INV-2610-097)', () => {
  const free = (key: string, grnItemId: string | null) => row(key, grnItemId, 1, read(0, 0));
  const inv = new Map([['jager', bill('jager', 440_00)], ['sofa', bill('sofa', 550_00)]]);
  it('counts on neither side: PO Amount is the sofa row only, and nothing shows red', () => {
    const r = review([free('1', null), free('2', null), free('3', null), row('4', 'sofa', 1, read(550, 550))]);
    const a = piAmounts(r, inv);
    expect(a).toEqual({ invoiceSen: 550_00, oursSen: 550_00, matchedInvoiceSen: 550_00, unmatched: 0 });
    expect(piAmountsDiffer(a)).toBe(false);
  });
  it('a free row a person tied to a priced line still does not count', () => {
    const a = piAmounts(review([free('1', 'jager'), row('4', 'sofa', 1, read(550, 550))]), inv);
    expect(a.oursSen).toBe(550_00);
    expect(piAmountsDiffer(a)).toBe(false);
  });
  it('is free at a printed 0, not when no price was read', () => {
    expect(isFreeRow(read(0, 0))).toBe(true);
    expect(isFreeRow(read(null, 0))).toBe(true);
    expect(isFreeRow(read(null, null))).toBe(false);
    expect(isFreeRow(read(550, 550))).toBe(false);
    expect(isFreeRow(null)).toBe(false);
  });
});
