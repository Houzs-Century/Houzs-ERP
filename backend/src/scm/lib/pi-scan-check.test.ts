/* Scan, check, then create, for supplier invoices (owner 2026-11-04): the working copy an invoice scan keeps. */
import { describe, expect, test } from 'vitest';
import { billBlocked, billCodesToTeach, billPicks, buildPiReview, cleanPiReview, duplicatePi, repeatedPis, suggestBills, type BillableLine, type ExistingPi, type PiReview, type PiReviewLine } from './pi-scan-check';
import type { PiScanExtract } from './pi-scan-extract';
import type { PiLineMatchResult } from './pi-scan-match';

const bill = (grnItemId: string, grnNumber: string, itemCode: string, remaining: number): BillableLine => ({ grnItemId, grnNumber, supplierId: 's1', poNumber: 'HC-PO-1', itemCode, description: null, remaining, unitPriceSen: 100_00 });
const parsed: PiScanExtract = { supplierName: 'DIGLANT', supplierCode: null, invoiceNumber: 'INV 7', invoiceDate: '2026-11-03', poNo: null, doNo: 'DO-1', lines: [
  { itemCode: 'T1MAMJA0MK', articleNo: null, description: 'Mattress Akemi Equinox K King', qty: 2, unitPrice: 500, salesTax: null, lineTotal: 1000 },
  { itemCode: 'ZZ', articleNo: null, description: 'Mattress Akemi Guardian Q Queen', qty: 1, unitPrice: 300, salesTax: null, lineTotal: 300 },
] };
const row = (description: string, qty: number): PiReviewLine => ({ key: description, grnItemId: null, grnNumber: null, qty, suggested: false, read: { itemCode: 'T1', description, qty, unitPrice: null, lineTotal: null } });

describe('pi scan check', () => {
  test('matched rows arrive tied, with what was printed; the rest stay to choose', () => {
    const match = { picks: [{ grnItemId: 'g1', qty: 2, grnNumber: 'HC-GRN-1', invoiceLineIndex: 0 }], unmatched: [{ invoiceLineIndex: 1, itemCode: 'ZZ', articleNo: null, description: 'x', qty: 1, billed: 0, reason: 'no_code_match' }], matchedLineCount: 1 } as PiLineMatchResult;
    const r = buildPiReview(parsed, 's1', match, [], ['HC-GRN-1']);
    expect(r).toMatchObject({ supplierId: 's1', invoiceNumber: 'INV 7', invoiceDate: '2026-11-03' });
    expect(r.lines.map((l) => [l.grnItemId, l.qty, l.read?.itemCode])).toEqual([['g1', 2, 'T1MAMJA0MK'], [null, 1, 'ZZ']]);
  });
  test('an invoice anchored to no GRN keeps every printed row', () => {
    expect(buildPiReview(parsed, null, null, [], []).lines).toHaveLength(2);
  });
  test('a part billed row keeps only what the match could not bill', () => {
    const match = { picks: [], unmatched: [{ invoiceLineIndex: 0, itemCode: null, articleNo: null, description: null, qty: 2, billed: 1, reason: 'qty_short' }], matchedLineCount: 0 } as PiLineMatchResult;
    expect(buildPiReview(parsed, 's1', match, [], []).lines[0].qty).toBe(1);
  });
  test('rows tie by name on the anchored GRN, never to the same SKU on another', () => {
    const lines = [row('Mattress Akemi Equinox K King', 1)];
    suggestBills(lines, [bill('x', 'HC-GRN-2', 'AKEMI EQUINOX MATT (K)', 1), bill('y', 'HC-GRN-1', 'AKEMI EQUINOX MATT (K)', 1)], ['HC-GRN-1']);
    expect(lines[0]).toMatchObject({ grnItemId: 'y', suggested: true });
  });
  test('with no anchor, only a single fitting line of the supplier', () => {
    const one = [row('Akemi Equinox K King', 1)];
    suggestBills(one, [bill('x', 'HC-GRN-2', 'AKEMI EQUINOX MATT (K)', 1)], []);
    expect(one[0].grnItemId).toBe('x');
    const two = [row('Akemi Equinox K King', 1)];
    suggestBills(two, [bill('x', 'HC-GRN-2', 'AKEMI EQUINOX MATT (K)', 1), bill('y', 'HC-GRN-3', 'AKEMI EQUINOX MATT (K)', 1)], []);
    expect(two[0].grnItemId).toBeNull();
  });
  test('the saved edit keeps known fields, drops a bad date and a negative qty', () => {
    const r = cleanPiReview({ invoiceNumber: ' INV 7 ', invoiceDate: '03/11/2026', extra: 1, lines: [{ key: 'k', grnItemId: 'g1', qty: -2, evil: 1 }] }) as PiReview;
    expect(r).toMatchObject({ invoiceNumber: 'INV 7', invoiceDate: null, lines: [{ key: 'k', grnItemId: 'g1', qty: 0 }] });
  });
  test('Create bills tied rows with a qty, one pick per line', () => {
    const r = { lines: [{ grnItemId: 'g1', qty: 1 }, { grnItemId: 'g1', qty: 1 }, { grnItemId: null, qty: 5 }, { grnItemId: 'g2', qty: 0 }] } as PiReview;
    expect(billPicks(r)).toEqual([{ grnItemId: 'g1', qty: 2, unitPriceSen: null }]);
  });
  test('picks carry the price the supplier printed, by qty when two rows share a line', () => {
    const read = (unitPrice: number | null) => ({ itemCode: null, description: null, qty: 1, unitPrice, lineTotal: null });
    const r = { lines: [{ grnItemId: 'g1', qty: 1, read: read(830) }, { grnItemId: 'g1', qty: 3, read: read(800) }, { grnItemId: 'g2', qty: 1, read: read(0) }, { grnItemId: 'g3', qty: 1, read: read(null) }] } as PiReview;
    expect(billPicks(r)).toEqual([
      { grnItemId: 'g1', qty: 4, unitPriceSen: 80_750 },
      { grnItemId: 'g2', qty: 1, unitPriceSen: 0 },
      { grnItemId: 'g3', qty: 1, unitPriceSen: null },
    ]);
  });
  test('blocked: nothing tied, a closed line, more than is left', () => {
    const open = new Map([['g1', bill('g1', 'HC-GRN-1', 'A1', 2)]]);
    expect(billBlocked({ lines: [] } as unknown as PiReview, open)).toMatch(/Choose the SKU/);
    expect(billBlocked({ lines: [{ grnItemId: 'gone', qty: 1 }] } as PiReview, open)).toMatch(/no longer open/);
    expect(billBlocked({ lines: [{ grnItemId: 'g1', qty: 3 }] } as PiReview, open)).toMatch(/3 is more than the 2 left to bill/);
    expect(billBlocked({ lines: [{ grnItemId: 'g1', qty: 2 }] } as PiReview, open)).toBeNull();
  });
  test('already billed: same invoice number of the same supplier, spacing and case aside', () => {
    const pi = (invoiceNumber: string, supplierId: string, supplierInvoiceRef: string): ExistingPi => ({ id: invoiceNumber, invoiceNumber, supplierId, supplierInvoiceRef, status: 'DRAFT', invoiceDate: null });
    const existing = [pi('HC-PI-1', 's1', 'inv7'), pi('HC-PI-2', 's2', 'INV 8')];
    expect(duplicatePi({ supplierId: 's1', invoiceNumber: 'INV 7' } as PiReview, existing)?.invoiceNumber).toBe('HC-PI-1');
    expect(duplicatePi({ supplierId: 's1', invoiceNumber: 'INV 8' } as PiReview, existing)).toBeNull();
    expect(duplicatePi({ supplierId: 's1', invoiceNumber: null } as PiReview, existing)).toBeNull();
  });
  test('the same invoice twice in the list: the later copy names the first', () => {
    const doc = (id: string, invoiceNumber: string) => ({ id, fileName: `${id}.pdf`, review: { supplierId: 's1', invoiceNumber } as PiReview });
    expect([...repeatedPis([doc('a', 'INV 1'), doc('b', 'inv1')])]).toEqual([['b', 'a.pdf']]);
  });
  test('a printed code confirmed on a tied row is taught', () => {
    const r = { lines: [{ grnItemId: 'g1', read: { itemCode: 'T1' } }, { grnItemId: null, read: { itemCode: 'T2' } }] } as unknown as PiReview;
    expect(billCodesToTeach(r, () => 'SKU-1')).toEqual([{ printedCode: 'T1', itemCode: 'SKU-1' }]);
  });
});
