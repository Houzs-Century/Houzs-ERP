// Regression cover for poLineFieldKinds — the PO-amendment line classifier that
// labels each follow-up preview row (docs/bugs). A product-lane SO amendment
// auto-raises a PO amendment whose preview rows carry the SO change; a
// colour/fabric/special edit moves no item_code, so it must be detected on the
// rendered variant SUMMARY (reusing the SO side's group-aware comparison), and a
// SPEC row must NOT read as a phantom QTY change.

import { describe, it, expect } from 'vitest';
import { poLineFieldKinds, type PoAmendmentLine } from './po-amendment-queries';

/* A four-axis bedframe spec (same shape so-amendment-line-diff.test.ts pins). */
const BEDFRAME_SPEC = {
  fabricCode:  'PC151-14',
  divanHeight: '8"',
  legHeight:   '1"',
  gap:         '12"',
  totalHeight: '21"',
};

const poLine = (over: Partial<PoAmendmentLine>): PoAmendmentLine => ({
  id: 'L', amendment_id: 'A', purchase_order_item_id: 'POI',
  change_type: 'SPEC',
  new_item_code: null, new_material_name: null,
  new_variants: null, new_qty: null,
  new_unit_price_sen: null, new_delivery_date: null,
  old_snapshot: null,
  ...over,
});

describe('poLineFieldKinds — follow-up preview classification', () => {
  it('detects a colour/fabric change with no item_code move as VARIANT, not QTY', () => {
    const line = poLine({
      change_type: 'SPEC',
      new_variants: { ...BEDFRAME_SPEC, fabricCode: 'PC151-01' },
      new_qty: null, // the fix: a SPEC row carries no unchanged qty
      old_snapshot: {
        preview: true, item_code: 'TRION', material_name: 'TRION BEDFRAME',
        qty: 1, item_group: 'bedframe', variants: { ...BEDFRAME_SPEC },
        description2: 'PC151-14 / DIVAN 8" + LEG 1" / GAP 12" / T.Heights 21"',
      },
    });
    // VARIANT only — no phantom QTY (old.qty is present and new_qty is null).
    expect(poLineFieldKinds(line)).toEqual(['VARIANT']);
  });

  it('a pure QTY change with a null variant blob is QTY only — never a false VARIANT', () => {
    const line = poLine({
      change_type: 'QTY',
      new_variants: null,
      new_qty: 3,
      old_snapshot: { preview: true, qty: 1, item_group: 'bedframe', variants: { ...BEDFRAME_SPEC } },
    });
    expect(poLineFieldKinds(line)).toEqual(['QTY']);
  });

  it('a code AND colour change reports both SPEC and VARIANT', () => {
    const line = poLine({
      change_type: 'SPEC',
      new_item_code: 'TRION-(K)-RHF',
      new_variants: { ...BEDFRAME_SPEC, fabricCode: 'PC151-01' },
      new_qty: null,
      old_snapshot: {
        preview: true, item_code: 'TRION-(K)-LHF',
        qty: 1, item_group: 'bedframe', variants: { ...BEDFRAME_SPEC },
      },
    });
    expect(poLineFieldKinds(line)).toEqual(['SPEC', 'VARIANT']);
  });

  it('an unchanged variant blob is not flagged (same spec both sides)', () => {
    const line = poLine({
      change_type: 'QTY',
      new_variants: { ...BEDFRAME_SPEC },
      new_qty: 2,
      old_snapshot: { preview: true, qty: 1, item_group: 'bedframe', variants: { ...BEDFRAME_SPEC } },
    });
    expect(poLineFieldKinds(line)).toEqual(['QTY']);
  });
});
