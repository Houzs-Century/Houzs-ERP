import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { persistLineKeys } from './autocount-line-keys';
import { fakeSb } from './fake-postgrest';

/* LINE KEYS THE ERP NEVER STORED — the documents the 0888 requeue refused.
 *
 * Probe run 34826755295 (production, read-only): every one of HC-PO-2609-087,
 * -027, -032, -009, -086, -010, -079, -074, -068 went to AutoCount as a
 * `so_to_po` TRANSFER and HC-PO-2609-064 as a `create_po`, all `sent`, and not
 * one of their lines carries `linked_ac_dtlkey` — not today, and not in the
 * po_revisions snapshot taken before their first amendment. 52 of 74 transfers
 * and 4 of 27 purchase creates since go-live are the same.
 *
 * Two refusals inside persistLineKeys, both written for CONVERSIONS, were
 * applied to operations whose line order is not presumed but CONSTRUCTED:
 *
 *   1. A TRANSFER compares the book's ItemCode with the code the ERP composed.
 *      AddSOToPOTransferDetail copies the SALES line's item, so the book holds
 *      'HOK-2038 (A) (Q)' where the ERP wrote 'CELENE (A)-(Q)' — recorded
 *      verbatim on HC-PO-2609-089 — and the check can never pass for a supplier-
 *      coded product.
 *   2. A CREATE with a repeated item code and no Desc2 in the lineWriteback is
 *      refused as "a guess" — HC-PO-2609-098 ('AK-BASTION MATT (Q)') and
 *      HC-PO-2609-064 ('5536-1NA' twice). A create adds its details in payload
 *      order and the host reads them back in DtlKey order: position IS identity.
 */
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('a CREATE stores keys by position even when a code repeats', () => {
  test('HC-PO-2609-064: 5536-1NA twice, no Desc2 in the lineWriteback', async () => {
    const sb = fakeSb({
      purchase_order_items: ['p-rhf', 'p-1na-a', 'p-lhf', 'p-1na-b'].map((id) => ({ id, linked_ac_dtlkey: null })),
    });
    const reason = await persistLineKeys(sb as never, { op: 'create_po', doc_no: 'HC-PO-2609-064' }, {
      table: 'purchase_order_items',
      ids: [['p-rhf'], ['p-1na-a'], ['p-lhf'], ['p-1na-b']],
      codes: ['5536-1A(RHF)', '5536-1NA', '5536-L(LHF)', '5536-1NA'],
    }, [
      { Seq: 0, DtlKey: 9001, ItemCode: '5536-1A(RHF)', Desc2: 'HR805-90 / SEAT 30' },
      { Seq: 1, DtlKey: 9002, ItemCode: '5536-1NA', Desc2: 'HR805-90 / SEAT 30' },
      { Seq: 2, DtlKey: 9003, ItemCode: '5536-L(LHF)', Desc2: 'HR805-90 / SEAT 30 / Special Order: Refer to ERP' },
      { Seq: 3, DtlKey: 9004, ItemCode: '5536-1NA', Desc2: 'HR805-90 / SEAT 30' },
    ]);
    expect(reason).toBeNull();
    expect(sb.tables.purchase_order_items.map((r) => [r.id, r.linked_ac_dtlkey]))
      .toEqual([['p-rhf', 9001], ['p-1na-a', 9002], ['p-lhf', 9003], ['p-1na-b', 9004]]);
  });

  test('CONTROL — a create whose book code DIFFERS at a position still stores nothing', async () => {
    const sb = fakeSb({ purchase_order_items: [{ id: 'p1', linked_ac_dtlkey: null }, { id: 'p2', linked_ac_dtlkey: null }] });
    const reason = await persistLineKeys(sb as never, { op: 'create_po', doc_no: 'HC-PO-X' }, {
      table: 'purchase_order_items', ids: [['p1'], ['p2']], codes: ['A', 'B'],
    }, [{ Seq: 0, DtlKey: 1, ItemCode: 'B' }, { Seq: 1, DtlKey: 2, ItemCode: 'A' }]);
    expect(reason).toContain('do not correspond');
    expect(sb.tables.purchase_order_items.every((r) => r.linked_ac_dtlkey == null)).toBe(true);
  });

  test('CONTROL — a CONVERSION with a repeated code and no Desc2 is still refused', async () => {
    const sb = fakeSb({ grn_items: [{ id: 'g1', linked_ac_dtlkey: null }, { id: 'g2', linked_ac_dtlkey: null }] });
    const reason = await persistLineKeys(sb as never, { op: 'po_to_gr', doc_no: 'HC-GRN-X' }, {
      table: 'grn_items', ids: [['g1'], ['g2']], codes: ['A', 'A'],
    }, [{ Seq: 0, DtlKey: 1, ItemCode: 'A' }, { Seq: 1, DtlKey: 2, ItemCode: 'A' }]);
    expect(reason).toContain('more than one line');
  });
});

describe('a TRANSFER stores keys by the source line each book line was transferred from', () => {
  /* HC-PO-2609-032 as it really is: three PO lines, each raised from one line of
     HC-SO-004928, and the book's item codes are the SALES items. */
  const tables = () => ({
    purchase_order_items: [
      { id: 'pl-star-ss', so_item_id: 'so-a', linked_ac_dtlkey: null },
      { id: 'pl-star-k', so_item_id: 'so-b', linked_ac_dtlkey: null },
      { id: 'pl-crown', so_item_id: 'so-c', linked_ac_dtlkey: null },
    ],
    mfg_sales_order_items: [
      { id: 'so-a', linked_ac_dtlkey: 345764 },
      { id: 'so-b', linked_ac_dtlkey: 345765 },
      { id: 'so-c', linked_ac_dtlkey: 345768 },
    ],
  });
  const target = (sourceDtlKeys: number[]) => ({
    table: 'purchase_order_items' as const,
    ids: [['pl-star-ss'], ['pl-star-k'], ['pl-crown']],
    codes: ['NB-KHJ05(SS)', 'NB-KHJ05(K)', 'NB-NBG06(SS+S)'],
    sourceDtlKeys,
  });

  test('the book line created from DtlKeys[i] goes to the ERP line whose sales line IS DtlKeys[i]', async () => {
    const sb = fakeSb(tables());
    const reason = await persistLineKeys(sb as never, { op: 'so_to_po', doc_no: 'HC-PO-2609-032' },
      target([345764, 345765, 345768]), [
        { Seq: 0, DtlKey: 7001, ItemCode: 'HOK-STAR (SS)' },
        { Seq: 1, DtlKey: 7002, ItemCode: 'HOK-STAR (K)' },
        { Seq: 2, DtlKey: 7003, ItemCode: 'HOK-CROWN (SS+S)' },
      ]);
    expect(reason).toBeNull();
    expect(sb.tables.purchase_order_items.map((r) => [r.id, r.linked_ac_dtlkey]))
      .toEqual([['pl-star-ss', 7001], ['pl-star-k', 7002], ['pl-crown', 7003]]);
  });

  test('a payload whose DtlKeys are NOT in its lines\' order (the pre-fix pairing) stores nothing and says so', async () => {
    const sb = fakeSb(tables());
    const reason = await persistLineKeys(sb as never, { op: 'so_to_po', doc_no: 'HC-PO-2609-032' },
      target([345768, 345765, 345764]), [
        { Seq: 0, DtlKey: 7001, ItemCode: 'HOK-CROWN (SS+S)' },
        { Seq: 1, DtlKey: 7002, ItemCode: 'HOK-STAR (K)' },
        { Seq: 2, DtlKey: 7003, ItemCode: 'HOK-STAR (SS)' },
      ]);
    expect(reason).toContain('transferred from');
    expect(sb.tables.purchase_order_items.every((r) => r.linked_ac_dtlkey == null)).toBe(true);
  });
});
