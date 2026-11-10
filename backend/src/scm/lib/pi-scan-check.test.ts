/* Scan, check, then create, for supplier invoices (owner 2026-11-04): the working copy an invoice scan keeps. */
import { describe, expect, test } from 'vitest';
import { addSalesTax, billBlocked, billCodesToTeach, billPicks, buildPiReview, cleanPiReview, duplicatePi, extractOfReview, repeatedPis, staleSuggestions, setPieces, suggestBills, NO_CODES, type BillableLine, type ExistingPi, type PiReview, type PiReviewLine } from './pi-scan-check';
import type { PiScanExtract } from './pi-scan-extract';
import { familiesByModelWord } from './scan-word-match';
import type { PiLineMatchResult } from './pi-scan-match';

const bill = (grnItemId: string, grnNumber: string, itemCode: string, remaining: number): BillableLine => ({ grnItemId, grnNumber, supplierId: 's1', poNumber: 'HC-PO-1', itemCode, supplierSku: null, description: null, remaining, unitPriceSen: 100_00, receivedAt: null });
const parsed: PiScanExtract = { supplierName: 'DIGLANT', supplierCode: null, invoiceNumber: 'INV 7', invoiceDate: '2026-11-03', poNo: null, doNo: 'DO-1', salesTax: null, totalAmount: null, lines: [
  { itemCode: 'T1MAMJA0MK', articleNo: null, description: 'Mattress Akemi Equinox K King', qty: 2, unitPrice: 500, salesTax: null, lineTotal: 1000 },
  { itemCode: 'ZZ', articleNo: null, description: 'Mattress Akemi Guardian Q Queen', qty: 1, unitPrice: 300, salesTax: null, lineTotal: 300 },
] };
const row = (description: string, qty: number): PiReviewLine => ({ key: description, grnItemId: null, grnNumber: null, qty, suggested: false, ai: false, read: { itemCode: 'T1', description, qty, unitPrice: null, lineTotal: null } });

describe('pi scan check', () => {
  test('matched rows arrive tied, with what was printed; the rest stay to choose', () => {
    const match = { picks: [{ grnItemId: 'g1', qty: 2, grnNumber: 'HC-GRN-1', invoiceLineIndex: 0 }], unmatched: [{ invoiceLineIndex: 1, itemCode: 'ZZ', articleNo: null, description: 'x', qty: 1, billed: 0, reason: 'no_code_match' }], matchedLineCount: 1 } as PiLineMatchResult;
    const r = buildPiReview(parsed, 's1', match, [], ['HC-GRN-1'], NO_CODES, null);
    expect(r).toMatchObject({ supplierId: 's1', invoiceNumber: 'INV 7', invoiceDate: '2026-11-03' });
    expect(r.lines.map((l) => [l.grnItemId, l.qty, l.read?.itemCode])).toEqual([['g1', 2, 'T1MAMJA0MK'], [null, 1, 'ZZ']]);
  });
  test('an invoice anchored to no GRN keeps every printed row', () => {
    expect(buildPiReview(parsed, null, null, [], [], NO_CODES, null).lines).toHaveLength(2);
  });
  test('a part billed row keeps only what the match could not bill', () => {
    const match = { picks: [], unmatched: [{ invoiceLineIndex: 0, itemCode: null, articleNo: null, description: null, qty: 2, billed: 1, reason: 'qty_short' }], matchedLineCount: 0 } as PiLineMatchResult;
    expect(buildPiReview(parsed, 's1', match, [], [], NO_CODES, null).lines[0].qty).toBe(1);
  });
  test('rows tie by name on the anchored GRN, never to the same SKU on another', () => {
    const lines = [row('Mattress Akemi Equinox K King', 1)];
    suggestBills(lines, [bill('x', 'HC-GRN-2', 'AKEMI EQUINOX MATT (K)', 1), bill('y', 'HC-GRN-1', 'AKEMI EQUINOX MATT (K)', 1)], ['HC-GRN-1'], new Map(), new Map());
    expect(lines[0]).toMatchObject({ grnItemId: 'y', suggested: true });
  });
  test('with no anchor, only a single fitting line of the supplier', () => {
    const one = [row('Akemi Equinox K King', 1)];
    suggestBills(one, [bill('x', 'HC-GRN-2', 'AKEMI EQUINOX MATT (K)', 1)], [], new Map(), new Map());
    expect(one[0].grnItemId).toBe('x');
    const two = [row('Akemi Equinox K King', 1)];
    suggestBills(two, [bill('x', 'HC-GRN-2', 'AKEMI EQUINOX MATT (K)', 1), bill('y', 'HC-GRN-3', 'AKEMI EQUINOX MATT (K)', 1)], [], new Map(), new Map());
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
  test('a row tied to another size is billed but not taught', () => {
    const r = { lines: [{ grnItemId: 'g1', read: { itemCode: 'DIVAN-(Q)' } }] } as unknown as PiReview;
    expect(billCodesToTeach(r, () => 'DIVAN ONLY-(K)')).toEqual([]);
    expect(billCodesToTeach(r, () => 'DIVAN ONLY-(Q)')).toEqual([{ printedCode: 'DIVAN-(Q)', itemCode: 'DIVAN ONLY-(Q)' }]);
  });
});

describe('a set billed on one row', () => {
  const piece = (id: string, sen: number): BillableLine => ({ ...bill(id, 'HC-GRN-1', id, 1), unitPriceSen: sen });
  const row = (unitPrice: number | null, qty = 1): PiReviewLine => ({ key: 'r', grnItemId: null, grnNumber: null, qty, suggested: false, ai: false, read: { itemCode: 'DSL 8075', description: '2 + L', qty, unitPrice, lineTotal: unitPrice } });
  test('one row becomes its pieces, the price shared as theirs is', () => {
    const out = setPieces(row(2000), [piece('a', 90000), piece('b', 110000)]);
    expect(out?.map((l) => [l.grnItemId, l.read?.unitPrice])).toEqual([['a', 900], ['b', 1100]]);
  });
  test('a price that is not the set, or more than one set, stays one row', () => {
    expect(setPieces(row(900), [piece('a', 90000), piece('b', 110000)])).toBeNull();
    expect(setPieces(row(2000, 2), [piece('a', 90000), piece('b', 110000)])).toBeNull();
    expect(setPieces(row(null), [piece('a', 90000), piece('b', 110000)])).toBeNull();
  });
});

describe('sales tax printed once at the bottom (Diglant)', () => {
  const row = (grnItemId: string | null, qty: number, unitPrice: number | null): PiReviewLine => ({ key: `${grnItemId}${unitPrice}`, grnItemId, grnNumber: null, qty, suggested: false, ai: false, read: { itemCode: null, description: 'x', qty, unitPrice, lineTotal: unitPrice == null ? null : unitPrice * qty } });
  const priced = (id: string, sen: number): BillableLine => ({ ...bill(id, 'GRN-1', id, 9), unitPriceSen: sen });
  test('DGSIZ26002253: each row reaches the PO price and the rows reach the total', () => {
    const lines = [row('a', 3, 544.55), row('b', 1, 1181.82), row('c', 1, 727.27), row('d', 1, 1409.09), row('e', 1, null)];
    const note = addSalesTax(lines, [priced('a', 59900), priced('b', 130000), priced('c', 80000), priced('d', 155000), priced('e', 0)], 495.18, 5447);
    expect(lines.map((l) => l.read?.unitPrice)).toEqual([599, 1300, 800, 1550, null]);
    expect(lines.reduce((a, l) => a + (l.read?.lineTotal ?? 0), 0)).toBeCloseTo(5447, 2);
    expect(note).toContain('495.18');
  });
  test('a printed .54 and .55 of one price both reach it', () => {
    const lines = [row('a', 1, 954.54), row('b', 1, 954.55)];
    addSalesTax(lines, [priced('a', 105000), priced('b', 105000)], 190.91, 2100);
    expect(lines.map((l) => l.read?.unitPrice)).toEqual([1050, 1050]);
  });
  test('no PO price to lean on: the rounding lands so the rows reach the total', () => {
    const lines = [row(null, 3, 1409.09)];
    addSalesTax(lines, [], 422.73, 4650);
    expect(lines[0]!.read?.lineTotal).toBe(4650);
    expect(lines[0]!.read?.unitPrice).toBe(1550);
  });
  test('tax of 0.00 leaves the row as printed', () => {
    const lines = [row('a', 50, 75)];
    expect(addSalesTax(lines, [priced('a', 7500)], 0, 3750)).toBeNull();
    expect(lines[0]!.read?.unitPrice).toBe(75);
  });
  test('one row already at the PO price holds its tax, the other takes it all', () => {
    const lines = [row('a', 1, 1550), row('b', 1, 1000)];
    addSalesTax(lines, [priced('a', 155000), priced('b', 110000)], 100, 2650);
    expect(lines.map((l) => l.read?.unitPrice)).toEqual([1550, 1100]);
  });
  test('any rate works: 6% takes its rate from the invoice', () => {
    const lines = [row('a', 2, 500), row('b', 1, 1000)];
    addSalesTax(lines, [priced('a', 53000), priced('b', 106000)], 120, 2120);
    expect(lines.map((l) => l.read?.unitPrice)).toEqual([530, 1060]);
  });
  test('tax not read: the total less the rows is the tax', () => {
    const lines = [row('a', 1, 1000), row('b', 1, 500)];
    expect(addSalesTax(lines, [], null, 1620)).toContain('120.00');
    expect(lines.map((l) => l.read?.lineTotal)).toEqual([1080, 540]);
  });
  test('neither read: the rows stay as printed', () => {
    const lines = [row('a', 1, 1409.09)];
    expect(addSalesTax(lines, [priced('a', 155000)], null, null)).toBeNull();
    expect(lines[0]!.read?.unitPrice).toBe(1409.09);
  });
  test('rows that cannot reach the total say so', () => {
    const lines = [row('a', 1, 1000)];
    expect(addSalesTax(lines, [priced('a', 110000)], 100, 1500)).toContain('invoice says RM 1,500.00');
  });
});

describe('NB prints its own code and the size in words (NBF2610-1322)', () => {
  const row = (itemCode: string, description: string): PiReviewLine => ({ key: itemCode, grnItemId: null, grnNumber: null, qty: 1, suggested: false, ai: false, read: { itemCode, description, qty: 1, unitPrice: 1380, lineTotal: 1380 } });
  const receipt = [bill('h1', 'GRN-2', 'HILTON (A)-(Q)', 1), bill('h2', 'GRN-2', 'HILTON (A)-(Q)', 1), bill('c1', 'GRN-2', 'CODY-(Q)', 1), bill('g1', 'GRN-2', 'GOYO (A)-(K)', 1), bill('x1', 'GRN-9', 'HILTON (A)-(Q)', 1)];
  const families = familiesByModelWord([{ supplierSku: 'NB-KHJ50(K)', itemCode: 'HILTON (A)-(K)' }, { supplierSku: 'NB-KHJ57(K)', itemCode: 'CODY-(K)' }]);
  test('the code names the family through another size, the row names the size', () => {
    const lines = [
      row('SB10-B11EC-KHJ50(A)(MH-12")', 'FABRIC 3 DIVAN BED SEATER:5 FTS COL: FG66151-1'),
      row('SB10-B11EC-KHJ57(MH-14")', 'FABRIC 3 DIVAN BED SEATER:5 FTS COL: FG66151-1'),
      row('SB10-B14EC-KHJ50(A)(MH-12")', 'FABRIC 3 DIVAN BED SEATER:5 FTS COL: FG66151-2'),
      row('SB12-KHB(C)-NH79(A)(MH-12")', 'FABRIC 3 DIVAN BED SEATER:6 FTS COL: FG66151-6'),
    ];
    suggestBills(lines, receipt, ['GRN-2'], families, new Map());
    expect(lines.map((l) => l.grnItemId)).toEqual(['h1', 'c1', 'h2', 'g1']);
    expect(lines.every((l) => l.suggested)).toBe(true);
  });
  test('with no receipt to anchor on, the last row of a size stays for a person', () => {
    const lines = [row('SB12-KHB(C)-NH79(A)(MH-12")', '6 FTS')];
    suggestBills(lines, receipt, [], families, new Map());
    expect(lines[0]!.grnItemId).toBeNull();
  });
});

describe('a waiting copy with no stored read rebuilds from its own rows', () => {
  const row = (itemCode: string, qty: number, readQty: number, unitPrice: number) => ({
    key: itemCode + qty, grnItemId: null, grnNumber: null, qty, suggested: false, ai: false,
    read: { itemCode, description: `${itemCode} desc`, qty: readQty, unitPrice, lineTotal: unitPrice * readQty },
  });
  const review = {
    v: 4, supplierId: null, supplierRead: 'HOOKKA INDUSTRIES SDN BHD', invoiceNumber: 'INV-2610-097', invoiceDate: '2026-10-22',
    doNo: 'DO-2610-090', poNo: null, notes: null, taxNote: null, lineTier: null,
    lines: [row('1007-(Q)', 1, 1, 425), row('1007-(Q)', 1, 1, 425), row('1013-(Q)', 2, 3, 305), row('1013-(Q)', 1, 3, 305)],
  };
  test('keeps the supplier name, D.O. and every printed row with its own pieces', () => {
    const x = extractOfReview(review)!;
    expect(x).toMatchObject({ supplierName: 'HOOKKA INDUSTRIES SDN BHD', doNo: 'DO-2610-090', invoiceNumber: 'INV-2610-097' });
    expect(x.lines.map((l) => [l.itemCode, l.qty, l.lineTotal])).toEqual([
      ['1007-(Q)', 1, 425], ['1007-(Q)', 1, 425], ['1013-(Q)', 2, 610], ['1013-(Q)', 1, 305],
    ]);
  });
  test('a copy with no printed rows has nothing to rebuild', () => {
    expect(extractOfReview({ ...review, lines: [] })).toBeNull();
  });
});

describe('a printed size never picks a different model (owner 2026-11-09, HOOKKA)', () => {
  const row = (itemCode: string, description: string): PiReviewLine => ({ key: itemCode + description, grnItemId: null, grnNumber: null, qty: 1, suggested: false, ai: false, read: { itemCode, description, qty: 1, unitPrice: 0, lineTotal: 0 } });
  const withDesc = (b: BillableLine, description: string): BillableLine => ({ ...b, description });
  test('CODY (HF) 3FT is not JAGER-(S), even as the last 3FT line on the receipt (INV-2610-097)', () => {
    const lines = [row('1007(HF)(W)-(S)', 'CODY BEDFRAME (HF) (3FT) (90X190CM)')];
    suggestBills(lines, [withDesc(bill('j', 'GRN-1', 'JAGER-(S)', 1), 'JAGER BEDFRAME (3FT) (90X190CM)')], ['GRN-1'], new Map(), new Map());
    expect(lines[0]!.grnItemId).toBeNull();
  });
  test('BREEVA 6FT is not DIVAN ONLY-(K) (INV-2610-027 row 12)', () => {
    const lines = [row('2137-(K)', 'BREEVA BEDFRAME (6FT) (183X190CM)')];
    suggestBills(lines, [withDesc(bill('d', 'GRN-1', 'DIVAN ONLY-(K)', 1), 'DIVAN ONLY BEDFRAME (6FT) (183X190CM)'), withDesc(bill('c', 'GRN-1', 'CODY-(K)', 1), 'CODY BEDFRAME (6FT) (183X190CM)')], ['GRN-1'], new Map(), new Map());
    expect(lines[0]!.grnItemId).toBeNull();
  });
  test('DIVAN ONLY 3FT is not JAGER-(S) (INV-2610-027 row 16)', () => {
    const lines = [row('DIVAN-(S)', 'DIVAN ONLY (3FT) (90X190CM)')];
    suggestBills(lines, [withDesc(bill('j', 'GRN-1', 'JAGER-(S)', 1), 'JAGER BEDFRAME (3FT) (90X190CM)')], ['GRN-1'], new Map(), new Map());
    expect(lines[0]!.grnItemId).toBeNull();
  });
  test('the same model of the size still matches by name', () => {
    const lines = [row('1013-(S)', 'JAGER BEDFRAME (3FT) (90X190CM)')];
    suggestBills(lines, [withDesc(bill('j', 'GRN-1', 'JAGER-(S)', 1), 'JAGER BEDFRAME (3FT) (90X190CM)'), withDesc(bill('c', 'GRN-1', 'CODY-(S)', 1), 'CODY BEDFRAME (3FT) (90X190CM)')], ['GRN-1'], new Map(), new Map());
    expect(lines[0]!.grnItemId).toBe('j');
  });
});

describe('a suggested tie to a receipt line another invoice billed is stale (owner 2026-11-10, INV-2610-097)', () => {
  const line = (key: string, grnItemId: string | null, suggested: boolean): PiReviewLine => ({ key, grnItemId, grnNumber: grnItemId ? 'GRN-1' : null, qty: 1, suggested, ai: false, read: { itemCode: key, description: key, qty: 1, unitPrice: 0, lineTotal: 0 } });
  const review = (lines: PiReviewLine[]): PiReview => ({ v: 5, supplierId: 's1', supplierRead: null, invoiceNumber: 'INV-2610-097', invoiceDate: null, doNo: null, poNo: null, notes: null, taxNote: null, lineTier: null, lines });
  test('counts only suggested rows whose line is no longer open', () => {
    const r = review([line('a', 'gone', true), line('b', 'open', true), line('c', 'gone', false), line('d', null, false)]);
    expect(staleSuggestions(r, new Set(['open']))).toBe(1);
  });
  test('nothing stale when every suggested line is still open', () => {
    expect(staleSuggestions(review([line('a', 'open', true)]), new Set(['open']))).toBe(0);
  });
});
