/* Scan, check, then create (owner 2026-11-03): the working copy a delivery-order scan keeps for the operator. */
import { describe, expect, test } from 'vitest';
import { blockedReason, buildReview, cleanReview, duplicateOf, giftsOf, picksOf, refVariants, repeatsInList, type ExistingGrn, type GrnReview } from './grn-scan-check';
import type { GrnMatchResult, OpenPoLine } from './grn-scan-match';

const parsed = { supplierName: 'DIGLANT', poNo: 'PO-1', doNo: 'DO 77', deliveryDate: '2026-11-03', lines: [
  { itemCode: 'A1', barcode: null, description: 'Mattress Q', qty: 2, poNo: null, rack: null },
  { itemCode: 'ZZ', barcode: null, description: 'Free pillow', qty: 1, poNo: null, rack: null },
] };
const match = { picks: [{ poItemId: 'pi-1', qty: 2 }], unmatched: [{ line: parsed.lines[1], reason: 'not_on_po', candidatePoItemIds: [] }] } as unknown as GrnMatchResult;
const open = new Map<string, OpenPoLine>([['pi-1', { poItemId: 'pi-1', poId: 'p', poNumber: 'HC-PO-1', supplierId: 's1', itemCode: 'A1', materialName: null, supplierSku: null, remaining: 2, locationCode: 'KL' }]]);

describe('grn scan check', () => {
  test('matched lines arrive tied to their PO line; unplaced lines arrive untied with what was printed', () => {
    const r = buildReview(parsed, 's1', match, []);
    expect(r).toMatchObject({ supplierId: 's1', supplierRead: 'DIGLANT', doNo: 'DO 77', deliveryDate: '2026-11-03' });
    expect(r.lines.map((l) => [l.poItemId, l.qty, l.read?.itemCode ?? null])).toEqual([['pi-1', 2, null], [null, 1, 'ZZ']]);
  });
  test('a read the matcher never saw keeps every printed line', () => {
    expect(buildReview(parsed, null, null, []).lines).toHaveLength(2);
  });
  test('the saved edit keeps known fields only, drops a bad date and a negative qty', () => {
    const r = cleanReview({ supplierId: 's1', doNo: ' DO 77 ', deliveryDate: '03/11/2026', lines: [{ key: 'k', poItemId: 'pi-1', qty: -3, evil: 1 }], extra: 'x' });
    expect(r).toEqual({ supplierId: 's1', supplierRead: null, doNo: 'DO 77', deliveryDate: null, notes: null, lines: [{ key: 'k', poItemId: 'pi-1', poNumber: null, gift: null, qty: 0, read: null }] });
  });
  test('a printed code taught as a free gift arrives marked as that product, on no PO', () => {
    const r = buildReview(parsed, 's1', match, [{ printedCode: 'ZZ', itemCode: 'PILLOW-1', name: 'Pillow', qty: 1 }]);
    expect(r.lines[1]).toMatchObject({ poItemId: null, gift: { itemCode: 'PILLOW-1', name: 'Pillow' }, qty: 1 });
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
