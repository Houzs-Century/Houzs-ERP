import { describe, expect, test } from 'vitest';
import { mergePoGrnLinks } from './po-list-read';

// The PO list "GRN No" column and has_children lock used to key off the GRN
// header FK only. A supplier multi-receive (grns POST /from-po-items) heads one
// GRN at the first PO while receiving lines across many, so every OTHER source
// PO showed no GRN and read has_children=false (Edit/Cancel offered on a received
// PO). mergePoGrnLinks unions the header FK with the grn_items line link.

describe('mergePoGrnLinks — GRN column + downstream lock union header FK with the line link', () => {
  test('a cross-PO receipt shows on the PO whose LINE it received, though its header names another PO', () => {
    const header = [{ poId: 'po933', grnId: 'g057', grnNumber: 'HC-GRN-2609-057' }];
    const line = [{ poId: 'po052', grnId: 'g057', grnNumber: 'HC-GRN-2609-057', cancelled: false }];
    const { childIds, grnsByPo } = mergePoGrnLinks(header, line);
    expect(childIds.has('po052')).toBe(true); // received -> downstream-locked
    expect(childIds.has('po933')).toBe(true);
    expect(grnsByPo.get('po052')).toEqual([{ id: 'g057', grnNumber: 'HC-GRN-2609-057' }]);
    expect(grnsByPo.get('po933')).toEqual([{ id: 'g057', grnNumber: 'HC-GRN-2609-057' }]);
  });

  test('a cancelled line-linked GRN is dropped: a cancelled receipt is not a lock and not a column entry', () => {
    const { childIds, grnsByPo } = mergePoGrnLinks(
      [],
      [{ poId: 'poX', grnId: 'gC', grnNumber: 'HC-GRN-1', cancelled: true }],
    );
    expect(childIds.has('poX')).toBe(false);
    expect(grnsByPo.get('poX')).toBeUndefined();
  });

  test('the same GRN reached by both header and line is listed once (dedup by id)', () => {
    const { grnsByPo } = mergePoGrnLinks(
      [{ poId: 'poA', grnId: 'g1', grnNumber: 'HC-GRN-1' }],
      [{ poId: 'poA', grnId: 'g1', grnNumber: 'HC-GRN-1', cancelled: false }],
    );
    expect(grnsByPo.get('poA')).toEqual([{ id: 'g1', grnNumber: 'HC-GRN-1' }]);
  });

  test('a header GRN with no grn_number still locks the PO but adds no column entry', () => {
    const { childIds, grnsByPo } = mergePoGrnLinks([{ poId: 'poA', grnId: 'g1', grnNumber: null }], []);
    expect(childIds.has('poA')).toBe(true);
    expect(grnsByPo.get('poA')).toBeUndefined();
  });
});
