/* line-po-link — the one reading of "which PO did this line come from", shared
   by the desktop grids, the desktop editors and the phone (#26). */
import { describe, expect, test } from 'vitest';
import { linePoLink, poDetailHref } from './line-po-link';

describe('linePoLink', () => {
  test('both halves present -> a ref', () => {
    expect(linePoLink({ source_po_id: 'u-1', source_po_number: 'HC-PO-010007' }))
      .toEqual({ id: 'u-1', number: 'HC-PO-010007' });
  });
  test('a manual line (nothing served) is null, never a guessed header PO', () => {
    expect(linePoLink({})).toBeNull();
    expect(linePoLink({ source_po_id: null, source_po_number: null })).toBeNull();
  });
  test('a number with no id cannot be opened, so it is not offered as a link', () => {
    expect(linePoLink({ source_po_id: null, source_po_number: 'HC-PO-1' })).toBeNull();
    expect(linePoLink({ source_po_id: 'u', source_po_number: '  ' })).toBeNull();
  });
});

describe('poDetailHref', () => {
  test('is the desktop purchase-order detail route', () => {
    expect(poDetailHref('429f472b-f0b2')).toBe('/scm/purchase-orders/429f472b-f0b2');
  });
});
