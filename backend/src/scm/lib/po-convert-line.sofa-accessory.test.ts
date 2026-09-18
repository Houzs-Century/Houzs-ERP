/* The colour of a Sofa Accessory line reaches the supplier's purchase order, for
   every SKU in the category (owner 2026-09-14). The colour is `variants.fabricCode`
   since the category exists; the Special Order text rides along as `SPECIAL:`
   (#3526). Both are group-driven, so this pins the nine SKUs he named. */
import { describe, expect, test } from 'vitest';
import { poConvertLineRow } from './po-convert-line';

const SKUS = ['SB02', 'BC05-MF', 'BC05', 'BC04-MF', 'BC04', 'AR02', 'AR01', 'SQUARE PILLOW', 'LONG PILLOW'];

describe('SO -> PO carries a Sofa Accessory colour', () => {
  test.each(SKUS)('%s: the PO line keeps the variants and prints the colour', (code) => {
    const variants = { fabricId: 'NICCA', fabricCode: 'NICCA-07', colourLabel: 'NICCA-07', extraAddonNote: 'Col:Nicca-07' };
    const row = poConvertLineRow('po-1', {
      itemCode: code, itemName: code, qty: 1, supplierSku: code, unitPriceSen: 0, warehouseId: null,
      deliveryDate: null, itemGroup: 'fabric_accessory', variants, soItemId: 'so-line-1', photoUrls: [],
    }, true, 'fabric_accessory');
    expect(row.item_group).toBe('fabric_accessory');
    expect(row.so_item_id).toBe('so-line-1');
    expect(row.variants).toEqual(variants);
    /* The note only repeats the colour, so it prints once (docs/bugs/0934). */
    expect(row.description2).toBe('NICCA-07');
  });

  test('a Special Order note that says more than the colour still rides along', () => {
    const variants = { fabricCode: 'BO315-28', extraAddonNote: 'BO315-28 SKY x2' };
    const row = poConvertLineRow('po-1', {
      itemCode: 'SQUARE PILLOW', itemName: 'SQUARE PILLOW', qty: 1, supplierSku: 'SQUARE PILLOW', unitPriceSen: 0, warehouseId: null,
      deliveryDate: null, itemGroup: 'fabric_accessory', variants, soItemId: 'so-line-1', photoUrls: [],
    }, true, 'fabric_accessory');
    expect(row.description2).toBe('BO315-28 / SPECIAL: BO315-28 SKY x2');
  });
});
