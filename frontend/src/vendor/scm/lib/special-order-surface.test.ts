/*
 * The owner asked where a custom pillow's COLOUR and an SP mattress's SIZE go
 * (2026-09-10). Before this module the answer was "nowhere": the Sales Order
 * only rendered a Special Order panel when the catalogue happened to define a
 * tickable add-on for that category, and it defines none for mattress and none
 * that reach accessories.
 *
 * These tests pin BOTH halves of the answer — the panel opens, and the checkbox
 * picker stays shut on the categories whose stock pools by code, because a
 * ticked add-on joins the variant key (`special=`) and would split the bucket
 * while the free text cannot.
 */
import { describe, it, expect } from 'vitest';
import { specialOrderSurface } from './special-order-surface';

describe('specialOrderSurface', () => {
  it('gives an SP mattress the panel even though the catalogue has no add-on to tick', () => {
    expect(specialOrderSurface({ category: 'mattress', hasItemCode: true, pickedSpecialCount: 0 }))
      .toEqual({ block: true, optionPicker: true });
  });

  it('gives a custom pillow the panel — free text only, no checkboxes', () => {
    expect(specialOrderSurface({ category: 'accessory', hasItemCode: true, pickedSpecialCount: 0 }))
      .toEqual({ block: true, optionPicker: false });
  });

  it('keeps the picker on a pooled line that ALREADY carries a pick, so it is not shown as retired', () => {
    expect(specialOrderSurface({ category: 'accessory', hasItemCode: true, pickedSpecialCount: 1 }))
      .toEqual({ block: true, optionPicker: true });
  });

  it('treats a dining/others line the same as an accessory — it is pooled too', () => {
    expect(specialOrderSurface({ category: 'others', hasItemCode: true, pickedSpecialCount: 0 }))
      .toEqual({ block: true, optionPicker: false });
  });

  it('gives sofa and bedframe NO standalone panel — theirs renders inside the configurator', () => {
    for (const category of ['sofa', 'bedframe']) {
      expect(specialOrderSurface({ category, hasItemCode: true, pickedSpecialCount: 0 }))
        .toEqual({ block: false, optionPicker: false });
    }
  });

  it('gives a SERVICE line nothing — a fee is not goods and orders nothing', () => {
    expect(specialOrderSurface({ category: 'service', hasItemCode: true, pickedSpecialCount: 0 }))
      .toEqual({ block: false, optionPicker: false });
  });

  it('shows nothing until a SKU is picked — there is nothing to describe yet', () => {
    expect(specialOrderSurface({ category: 'accessory', hasItemCode: false, pickedSpecialCount: 0 }))
      .toEqual({ block: false, optionPicker: false });
  });

  it('reads the category case- and space-insensitively (the resolver can hand back either)', () => {
    expect(specialOrderSurface({ category: ' ACCESSORY ', hasItemCode: true, pickedSpecialCount: 0 }))
      .toEqual({ block: true, optionPicker: false });
  });
});
