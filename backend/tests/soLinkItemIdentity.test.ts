// The rule POST /purchase-orders was missing: a PO line may only name a
// sales-order line for the SAME product. lib/so-link-item-identity.ts.
//
// The other four bind paths in mfg-purchase-orders.ts have enforced this since
// 2026-08-08 through soLinkTargetRefusal; the create path checked company scope
// and the qty cap and stopped. so_item_id is what makes a hard-bound line read
// READY (isHardBoundLine), so a wrong bind lights the wrong bed — which is what
// the importer did to nine live lines on 2026-09-07 (docs/bugs/0671).
// Bug class: docs/bugs/0672-bug-class-key-without-identity.
import { describe, expect, it } from 'vitest';

import { soLinkItemMismatch, type SoSourceLine } from '../src/scm/lib/so-link-item-identity';

const so = (over: Partial<SoSourceLine> = {}): SoSourceLine => ({
  id: 'so-1', doc_no: 'HC-SO-002558', item_code: 'REGAL (A)-(K)', qty: 1, po_qty_picked: 0, ...over,
});

describe('soLinkItemMismatch', () => {
  it('allows a bind whose two lines name the same product', () => {
    expect(soLinkItemMismatch([{ soItemId: 'so-1', itemCode: 'REGAL (A)-(K)' }], [so()])).toBeNull();
  });

  /* The real pairs from the 2026-09-07 incident. The importer wrote every one
     of these; the create path would have accepted them too. */
  it.each([
    ['REGAL (A)-(K)', 'TRION (A) (HB STR)-(K)'],
    ['FENRIR-(Q)', 'HILTON (A)-(Q)'],
    ['JAGER-(Q)', 'JAGER-(SS)'],
    ['CODY-(Q)', 'JAGER-(Q)'],
    ['TIFANNY-(K)', 'TIFANNY 2.0 (F)-(K)'],
  ])('refuses a PO line for %s bound to a sales-order line for %s', (poCode, soCode) => {
    const bad = soLinkItemMismatch([{ soItemId: 'so-1', itemCode: poCode }], [so({ item_code: soCode })]);
    expect(bad?.error).toBe('so_link_material_mismatch');
    expect(bad?.itemCode).toBe(poCode);
    expect(bad?.soItemCode).toBe(soCode);
    expect(bad?.soItemId).toBe('so-1');
  });

  it('reads the codes the way a person does — case, padding and inner spacing are not a different product', () => {
    expect(soLinkItemMismatch(
      [{ soItemId: 'so-1', itemCode: '  regal   (a)-(k) ' }],
      [so({ item_code: 'REGAL (A)-(K)' })],
    )).toBeNull();
  });

  it('leaves a manual line alone — no soItemId is not a link to check', () => {
    expect(soLinkItemMismatch([{ itemCode: 'ANYTHING' }], [])).toBeNull();
  });

  /* A blank code on either side cannot be asserted equal to anything, so it is
     refused rather than waved through. Two blanks are not a match. */
  it('refuses a bind when the sales-order line carries no item code', () => {
    expect(soLinkItemMismatch([{ soItemId: 'so-1', itemCode: 'REGAL (A)-(K)' }], [so({ item_code: null })])?.error)
      .toBe('so_link_material_mismatch');
    expect(soLinkItemMismatch([{ soItemId: 'so-1', itemCode: '' }], [so({ item_code: '' })])?.error)
      .toBe('so_link_material_mismatch');
  });

  it('refuses a soItemId that resolves to no row at all', () => {
    expect(soLinkItemMismatch([{ soItemId: 'ghost', itemCode: 'REGAL (A)-(K)' }], [so()])?.soItemId).toBe('ghost');
  });

  it('reports the FIRST offending line, and checks past a good one to find it', () => {
    const bad = soLinkItemMismatch(
      [{ soItemId: 'so-1', itemCode: 'REGAL (A)-(K)' }, { soItemId: 'so-2', itemCode: 'CODY-(Q)' }],
      [so(), so({ id: 'so-2', item_code: 'JAGER-(Q)' })],
    );
    expect(bad?.itemCode).toBe('CODY-(Q)');
  });
});
