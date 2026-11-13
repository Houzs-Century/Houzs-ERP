/* Scan, check, then create (owner 2026-11-03): the working copy a delivery-order scan keeps for the operator. */
import { describe, expect, test } from 'vitest';
import { REVIEW_VERSION, inPrintedOrder, blockedReason, buildReview, codesToTeach, nameFits, racksOf, suggestByName, type ReviewLine, cleanReview, duplicateOf, giftsOf, picksOf, refVariants, repeatsInList, type ExistingGrn, type GrnReview } from './grn-scan-check';
import type { GrnMatchResult, OpenPoLine } from './grn-scan-match';

const parsed = { supplierName: 'DIGLANT', poNo: 'PO-1', doNo: 'DO 77', deliveryDate: '2026-11-03', lines: [
  { itemCode: 'A1', barcode: null, description: 'Mattress Q', qty: 2, poNo: null, rack: null },
  { itemCode: 'ZZ', barcode: null, description: 'Free pillow', qty: 1, poNo: null, rack: null },
] };
const match = { picks: [{ poItemId: 'pi-1', qty: 2 }], racks: { 'pi-1': 'R11-2' }, rackQty: {}, unmatched: [{ line: parsed.lines[1], reason: 'not_on_po', candidatePoItemIds: [] }] } as unknown as GrnMatchResult;
const open = new Map<string, OpenPoLine>([['pi-1', { poItemId: 'pi-1', poId: 'p', poNumber: 'HC-PO-1', supplierId: 's1', itemCode: 'A1', materialName: null, supplierSku: null, remaining: 2, locationCode: 'KL' }]]);

describe('grn scan check', () => {
  test('matched lines arrive tied to their PO line; unplaced lines arrive untied with what was printed', () => {
    const r = buildReview(parsed, 's1', match, [], [...open.values()], '2026-11-06');
    // The day of the scan, not the 2026-11-03 printed on the delivery order.
    expect(r).toMatchObject({ supplierId: 's1', supplierRead: 'DIGLANT', doNo: 'DO 77', deliveryDate: '2026-11-06' });
    expect(r.lines.map((l) => [l.poItemId, l.qty, l.rack, l.read?.itemCode ?? null])).toEqual([['pi-1', 2, 'R11-2', 'A1'], [null, 1, null, 'ZZ']]);
  });
  test('a read the matcher never saw keeps every printed line', () => {
    expect(buildReview(parsed, null, null, [], [], '2026-11-06').lines).toHaveLength(2);
  });
  test('the saved edit keeps known fields only, drops a bad date and a negative qty', () => {
    const r = cleanReview({ supplierId: 's1', doNo: ' DO 77 ', deliveryDate: '03/11/2026', lines: [{ key: 'k', poItemId: 'pi-1', qty: -3, evil: 1 }], extra: 'x' });
    expect(r).toEqual({ v: REVIEW_VERSION, supplierId: 's1', supplierRead: null, doNo: 'DO 77', deliveryDate: null, notes: null, lines: [{ key: 'k', poItemId: 'pi-1', poNumber: null, gift: null, qty: 0, rack: null, suggested: false, read: null }] });
  });
  describe('tying rows by the name printed (real DIGLANT rows, 2026-11-04)', () => {
    const po = (poItemId: string, poNumber: string, itemCode: string, remaining: number): OpenPoLine => ({ poItemId, poId: poNumber, poNumber, supplierId: 's1', itemCode, materialName: null, supplierSku: null, remaining, locationCode: 'KL' });
    const row = (description: string, qty: number): ReviewLine => ({ key: description, poItemId: null, poNumber: null, gift: null, qty, rack: null, suggested: false, read: { itemCode: 'T1', description, qty, poNo: null } });
    test('the size must be a word of its own: (S) is not (SS)', () => {
      expect(nameFits('Mattress Akemi Medi+Health Equinox K King 183x190x30cm', 'AKEMI EQUINOX MATT (K)')).toBe(true);
      expect(nameFits('Mattress Akemi Medi+Health Ultimate SS Super Single', 'AKEMI ULTIMATE MATT (S)')).toBe(false);
      expect(nameFits('Mattress Akemi Medi+Health Ultimate SS Super Single', 'AKEMI ULTIMATE MATT (SS)')).toBe(true);
      expect(nameFits('Mattress Akemi Guardian Q Queen', 'AKEMI ULTIMATE MATT (Q)')).toBe(false);
    });
    test('a PO printed with its location finds our PO, and takes the row (DGSN26002432)', () => {
      const lines = [row('Mattress Akemi Medi+Health Ultimate SS Super Single 107x190x36cm', 1)];
      suggestByName(lines, [po('a', 'HC-PO-2610-358', 'AKEMI ULTIMATE MATT (SS)', 1)], ['HC-SBH-PO-2610-358']);
      expect(lines[0]).toMatchObject({ poItemId: 'a', suggested: true });
    });
    test('the PO the other rows are on wins over the same SKU on other POs (DGSN26002439)', () => {
      const lines: ReviewLine[] = [{ ...row('tied', 2), poItemId: 'other', read: null }, row('Mattress Akemi Medi+Health Equinox K King', 1)];
      suggestByName(lines, [po('other', 'HC-PO-2610-359', 'AKEMI GUARDIAN MATT (Q)', 2), po('x', 'HC-PO-2610-356', 'AKEMI EQUINOX MATT (K)', 1), po('y', 'HC-PO-2610-359', 'AKEMI EQUINOX MATT (K)', 1)], []);
      expect(lines[1].poItemId).toBe('y');
    });
    test('never a guess: the printed PO has no such line, or many POs fit and none is known', () => {
      const a = [row('Mattress Akemi Guardian Q Queen', 3)];
      suggestByName(a, [po('x', 'HC-PO-2', 'AKEMI GUARDIAN MATT (Q)', 5)], ['HC-PO-2610-311']);
      expect(a[0].poItemId).toBeNull();
      const b = [row('Mattress Akemi Guardian Q Queen', 1)];
      suggestByName(b, [po('x', 'HC-PO-2', 'AKEMI GUARDIAN MATT (Q)', 5), po('y', 'HC-PO-3', 'AKEMI GUARDIAN MATT (Q)', 5)], []);
      expect(b[0].poItemId).toBeNull();
    });
    test('two rows of one item do not both take the one line that owes', () => {
      const lines = [row('Akemi Equinox K King', 1), row('Akemi Equinox K King', 1)];
      suggestByName(lines, [po('x', 'HC-PO-1', 'AKEMI EQUINOX MATT (K)', 1)], ['HC-PO-1']);
      expect(lines.map((l) => l.poItemId)).toEqual(['x', null]);
    });
  });
  test('rows come in the order the paper prints them, matched ones with what they printed', () => {
    const open = [
      { poItemId: 'u', poId: 'p', poNumber: 'HC-PO-236', supplierId: 's1', itemCode: 'AKEMI ULTIMATE MATT (Q)', materialName: null, supplierSku: null, remaining: 5, locationCode: 'KL' },
      { poItemId: 'g', poId: 'p', poNumber: 'HC-PO-236', supplierId: 's1', itemCode: 'AKEMI GUARDIAN MATT (K)', materialName: null, supplierSku: null, remaining: 3, locationCode: 'KL' },
    ];
    const printed = [
      { itemCode: 'T1G', barcode: null, description: 'Mattress Akemi Guardian K King', qty: 3, poNo: null, rack: null },
      { itemCode: 'T1U', barcode: null, description: 'Mattress Akemi Ultimate Q Queen', qty: 5, poNo: null, rack: null },
    ];
    const lines = [{ key: 'u', poItemId: 'u', poNumber: null, gift: null, qty: 5, rack: null, suggested: false, read: null }, { key: 'g', poItemId: 'g', poNumber: null, gift: null, qty: 3, rack: null, suggested: true, read: { itemCode: 'T1G', description: 'Mattress Akemi Guardian K King', qty: 3, poNo: null } }];
    const out = inPrintedOrder(lines, printed, open, new Set());
    expect(out.map((l) => l.key)).toEqual(['g', 'u']);
    expect(out[1].read?.itemCode).toBe('T1U');
  });
  test('a rack goes to its PO line, whatever the product; a code confirmed is taught', () => {
    const r = { lines: [
      { poItemId: 'p1', qty: 1, rack: 'R11-2', read: { itemCode: 'T1', description: null, qty: 1, poNo: null } },
      { poItemId: 'p2', qty: 1, rack: null, read: null },
      { poItemId: null, qty: 1, rack: 'L1-1', read: { itemCode: 'T3', description: null, qty: 1, poNo: null } },
    ] } as unknown as GrnReview;
    expect(racksOf(r)).toEqual({ p1: { 'R11-2': 1 } });
    expect(codesToTeach(r, (id) => (id === 'p1' ? 'SOFA-1' : undefined))).toEqual([{ printedCode: 'T1', itemCode: 'SOFA-1' }]);
  });
  test('a printed code taught as a free gift arrives marked as that product, on no PO', () => {
    const r = buildReview(parsed, 's1', match, [{ printedCode: 'ZZ', itemCode: 'PILLOW-1', name: 'Pillow', qty: 1 }], [], '2026-11-06');
    expect(r.lines.find((l) => l.gift)).toMatchObject({ poItemId: null, gift: { itemCode: 'PILLOW-1', name: 'Pillow' }, qty: 1 });
  });
  test('the same delivery order twice in the waiting list: the later copy names the first', () => {
    const doc = (id: string, doNo: string | null) => ({ id, fileName: `${id}.pdf`, review: { supplierId: 's1', doNo } as GrnReview });
    expect([...repeatsInList([doc('a', 'DO 1'), doc('b', 'do1'), doc('c', 'DO 2'), doc('d', null)])]).toEqual([['b', 'a.pdf']]);
  });
  test('the database look-up tries the spellings the comparison treats as one', () => {
    expect(refVariants('Do 77')).toEqual(['Do 77', 'DO 77', 'do 77', 'Do77', 'DO77']);
  });
  test('a free gift is never also a PO line, and adds up per product with its printed code', () => {
    const r = cleanReview({ lines: [
      { key: 'a', poItemId: 'pi-1', gift: { itemCode: 'P', name: 'Pillow' }, qty: 2, read: { itemCode: 'GWP', qty: 2 } },
      { key: 'b', gift: { itemCode: 'P', name: 'Pillow' }, qty: 3 },
    ] }) as GrnReview;
    expect(r.lines[0].poItemId).toBeNull();
    expect(picksOf(r)).toEqual([]);
    expect(giftsOf(r)).toEqual([{ printedCode: 'GWP', itemCode: 'P', name: 'Pillow', qty: 5 }]);
  });
  test('Create converts tied lines with a qty, one pick per PO line', () => {
    const r = { lines: [{ poItemId: 'pi-1', qty: 1 }, { poItemId: 'pi-1', qty: 1 }, { poItemId: null, qty: 5 }, { poItemId: 'pi-2', qty: 0 }] } as GrnReview;
    expect(picksOf(r)).toEqual([{ poItemId: 'pi-1', qty: 2 }]);
  });
  test('blocked: nothing tied, a closed line, more than owed', () => {
    expect(blockedReason({ lines: [] } as unknown as GrnReview, open)).toMatch(/No line/);
    expect(blockedReason({ lines: [{ poItemId: 'gone', qty: 1 }] } as GrnReview, open)).toMatch(/no longer open/);
    expect(blockedReason({ lines: [{ poItemId: 'pi-1', qty: 3 }] } as GrnReview, open)).toMatch(/3 is more than the 2 still owed/);
    expect(blockedReason({ lines: [{ poItemId: 'pi-1', qty: 2 }] } as GrnReview, open)).toBeNull();
  });
  test('already received: the same D.O. no of the same supplier, spacing and case aside', () => {
    const grn = (grnNumber: string, supplierId: string, deliveryNoteRef: string): ExistingGrn => ({ id: grnNumber, grnNumber, supplierId, deliveryNoteRef, status: 'DRAFT', receivedAt: null });
    const existing = [grn('HC-GRN-1', 's1', 'do77'), grn('HC-GRN-2', 's2', 'DO 88')];
    expect(duplicateOf({ supplierId: 's1', doNo: 'DO 77' } as GrnReview, existing)?.grnNumber).toBe('HC-GRN-1');
    expect(duplicateOf({ supplierId: 's1', doNo: 'DO 88' } as GrnReview, existing)).toBeNull();
    expect(duplicateOf({ supplierId: 's1', doNo: null } as GrnReview, existing)).toBeNull();
  });
});

describe('a set row on the check screen (DO-2610-01)', () => {
  test('both pieces show the one row that printed them, each on its own PO line', () => {
    const printed = { itemCode: 'DSL 8075(28")-2+1', barcode: null, description: '*2990-SO-2609-045', qty: 1, poNo: null, rack: null };
    const parsed = { supplierName: 'DORSETTLOFT', poNo: 'S/O 1878', doNo: 'DO-2610-01', deliveryDate: '2026-10-05', lines: [printed] };
    const match = { picks: [{ poItemId: 'a2', qty: 1 }, { poItemId: 'aL', qty: 1 }], unmatched: [], racks: {}, rackQty: {}, soMatches: [{ line: printed, soDocNo: '2990-SO-2609-045', poItemIds: ['a2', 'aL'] }] } as unknown as Parameters<typeof buildReview>[2];
    const review = buildReview(parsed, 's1', match, [], [], '2026-11-06');
    expect(review.lines.map((l) => [l.poItemId, l.read?.itemCode])).toEqual([['a2', 'DSL 8075(28")-2+1'], ['aL', 'DSL 8075(28")-2+1']]);
  });
});

describe('DO-2611-037: the card follows the paper, and a row keeps its printed PO', () => {
  const ln = (itemCode: string, description: string, poNo: string | null) => ({ itemCode, barcode: null, description, qty: 1, poNo, rack: null });
  const paper = [
    ln('1007-(Q)', 'CODY BEDFRAME (5FT) PC151-14', 'HC-PO-2610-399'),
    ln('5567-1A(RHF)', 'SOFA 5567 1A(RHF)', 'HC-PO-2610-197'),
    ln('5536-1NA', 'SOFA 5536 1NA COVE-05', 'HC-PO-2610-103'),
  ];
  const doc = { supplierName: 'HOOKKA', poNo: null, doNo: 'DO-2611-037', deliveryDate: null, lines: paper };
  const ol = (poItemId: string, poNumber: string, itemCode: string): OpenPoLine => ({ poItemId, poId: poNumber, poNumber, supplierId: 's1', itemCode, materialName: null, supplierSku: `HOK-${itemCode}`, remaining: 1, locationCode: 'KL' });
  const lines = [ol('cody', 'HC-PO-2610-399', '1007-(Q)'), ol('5540r', 'HC-PO-2610-197', '5540-1A(RHF)'), ol('5536', 'HC-PO-2610-103', '5536-1NA')];
  const m = {
    picks: [{ poItemId: '5536', qty: 1 }, { poItemId: 'cody', qty: 1 }], racks: {}, rackQty: {},
    rowOf: { cody: paper[0], '5536': paper[2] },
    unmatched: [{ line: paper[1], reason: 'not_on_po', candidatePoItemIds: [] }],
  } as unknown as GrnMatchResult;
  const r = buildReview(doc, 's1', m, [], lines, '2026-11-13');

  test('rows come in the order the delivery order prints them', () => {
    expect(r.lines.map((l) => l.read?.itemCode)).toEqual(['1007-(Q)', '5567-1A(RHF)', '5536-1NA']);
  });

  test('an unmatched row starts on the open PO it prints', () => {
    expect(r.lines[1]).toMatchObject({ poItemId: null, poNumber: 'HC-PO-2610-197' });
  });
});
