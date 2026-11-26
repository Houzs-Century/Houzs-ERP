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

  it('gives a Sofa Accessory line the panel — its own panel holds only the fabric picker', () => {
    /* HC-SO-2609-071 (owner 2026-09-15): five pillow / cushion lines carried
       "Special Fabric-GD526-16 (BEETEX Chenille)" in extraAddonNote, the PDF
       printed it, and the edit screen showed no Special Order panel at all. */
    expect(specialOrderSurface({ category: 'fabric_accessory', hasItemCode: true, pickedSpecialCount: 0 }))
      .toEqual({ block: true, optionPicker: true });
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
