/* Owner 2026-09-28, HC-PO-010114: 「系统找不到 GRN - 但是现实已经received stock …
   现在我要做 purchase return - 需要 GRN convert」.

   Both units WERE received — on HC-GRN-2609-098 and HC-GRN-2609-155, two
   receipts HEADED at a different purchase order (one group, one lorry, several
   suppliers' orders on one receipt — deliberate, confirmed by the owner). The
   old pool matched `grns.purchase_order_id` only, so the return screen offered
   nothing to return.

   Each case below is one way that read could be wrong again. */

import { describe, expect, it } from 'vitest';
import { buildReturnablePool, type GrnLineRow } from './returnable-grn-lines';

const line = (over: Partial<GrnLineRow> = {}): GrnLineRow => ({
  id: 'gi-1',
  grn_id: 'grn-posted',
  purchase_order_item_id: 'poi-1',
  material_kind: 'mfg_product',
  item_code: 'CELENE (A)-(SP)',
  material_name: 'HOK-CELENE (A) B/FRAME (SPECIAL SIZE)',
  item_group: 'BEDFRAME',
  variants: null,
  qty_accepted: 1,
  returned_qty: 0,
  unit_price_sen: 0,
  rejection_reason: null,
  ...over,
});

const posted = new Map([['grn-posted', 'HC-GRN-2609-155'], ['grn-own', 'HC-GRN-2609-001']]);
const mine = new Set(['poi-1', 'poi-2']);
const headedHere = new Set(['grn-own']);

const pool = (rows: GrnLineRow[]) => buildReturnablePool(rows, posted, mine, headedHere);

describe('buildReturnablePool', () => {
  it('RETURNS a line received on another PO\'s receipt — the defect', () => {
    const out = pool([line({ id: 'gi-x', grn_id: 'grn-posted', purchase_order_item_id: 'poi-1' })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ grnItemId: 'gi-x', grnNumber: 'HC-GRN-2609-155', remaining: 1 });
  });

  it('does NOT return another order\'s line that rode along on the same receipt', () => {
    expect(pool([line({ id: 'gi-other', purchase_order_item_id: 'poi-someone-else' })])).toEqual([]);
  });

  it('keeps the legacy case: an UNLINKED line on this order\'s own receipt', () => {
    const out = pool([line({ id: 'gi-legacy', grn_id: 'grn-own', purchase_order_item_id: null })]);
    expect(out.map((l) => l.grnItemId)).toEqual(['gi-legacy']);
  });

  it('drops an unlinked line on someone else\'s receipt — it says nothing about this order', () => {
    expect(pool([line({ id: 'gi-loose', grn_id: 'grn-posted', purchase_order_item_id: null })])).toEqual([]);
  });

  it('ignores a receipt that is not POSTED — that stock has not moved in', () => {
    expect(pool([line({ id: 'gi-draft', grn_id: 'grn-draft' })])).toEqual([]);
  });

  it('drops a line already fully returned, and keeps a partially returned one', () => {
    expect(pool([line({ id: 'gi-done', qty_accepted: 2, returned_qty: 2 })])).toEqual([]);
    const [partial] = pool([line({ id: 'gi-part', qty_accepted: 3, returned_qty: 1 })]);
    expect(partial).toMatchObject({ grnItemId: 'gi-part', remaining: 2 });
  });

  it('never answers a negative remaining, however the counters drifted', () => {
    expect(pool([line({ id: 'gi-odd', qty_accepted: 1, returned_qty: 5 })])).toEqual([]);
  });

  it('counts a line once when both reads deliver it', () => {
    const dup = line({ id: 'gi-dup', grn_id: 'grn-own', purchase_order_item_id: 'poi-2' });
    expect(pool([dup, { ...dup }])).toHaveLength(1);
  });

  it('carries what the return draft needs, with a missing price read as zero', () => {
    const [l] = pool([line({ id: 'gi-full', unit_price_sen: null, rejection_reason: 'Broken leg' })]);
    expect(l).toMatchObject({
      itemCode: 'CELENE (A)-(SP)',
      materialName: 'HOK-CELENE (A) B/FRAME (SPECIAL SIZE)',
      itemGroup: 'BEDFRAME',
      materialKind: 'mfg_product',
      unitPriceSen: 0,
      rejectionReason: 'Broken leg',
    });
  });
});
