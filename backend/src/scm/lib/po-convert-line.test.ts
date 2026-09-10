// ----------------------------------------------------------------------------
// The two convert arms build the SAME purchase-order line.
//
// `convertSosToPosCore` appends to an existing PO and creates new ones, and
// until 2026-09-10 each arm carried its own copy of the row literal. Nothing
// checked that they agreed, and they had already drifted in their comments; a
// field added to one and not the other is invisible until a document is missing
// it in production. The shape is one function now, and this is what says so.
import { describe, expect, test } from 'vitest';
import { poConvertLineRow, type PoConvertLine } from './po-convert-line';

const line: PoConvertLine = {
  itemCode: '8030-L(LHF)',
  itemName: 'SOFA 8030 L LHF',
  qty: 2,
  supplierSku: 'HOK-8030-L',
  unitPriceSen: 123456,
  warehouseId: 'wh-kl',
  deliveryDate: '2026-10-01',
  itemGroup: 'sofa',
  variants: { fabricCode: 'EZ-003' },
  soItemId: 'si-1',
  photoUrls: ['so-items/HC-SO-013503/si-1/build.jpg'],
};

describe('poConvertLineRow', () => {
  test('writes exactly the columns the convert has always written', () => {
    /* Spelled out rather than snapshotted: a column added here has to be added
       to this list on purpose, which is the review this extraction exists to
       make possible. `line_no` is deliberately ABSENT — stampPoLineNos adds it
       after the caller has ordered the payload (lib/po-line-order.ts). */
    expect(Object.keys(poConvertLineRow('po-1', line, false)).sort()).toEqual([
      'delivery_date', 'description2', 'from_mrp', 'item_code', 'item_group',
      'line_total_sen', 'material_kind', 'material_name', 'photo_urls',
      'purchase_order_id', 'qty', 'so_item_id', 'supplier_sku', 'unit_price_sen',
      'variants', 'warehouse_id',
    ]);
  });

  test('the PO id is the only thing that differs between the two arms', () => {
    const appended = poConvertLineRow('po-existing', line, false);
    const created = poConvertLineRow('po-new', line, false);
    expect({ ...appended, purchase_order_id: null }).toEqual({ ...created, purchase_order_id: null });
    expect(appended.purchase_order_id).toBe('po-existing');
    expect(created.purchase_order_id).toBe('po-new');
  });

  test('the money is qty x unit price, in sen', () => {
    expect(poConvertLineRow('po-1', line, false).line_total_sen).toBe(2 * 123456);
  });

  test('from_mrp rides through — it decides whether the SO quota locks', () => {
    expect(poConvertLineRow('po-1', line, true).from_mrp).toBe(true);
    expect(poConvertLineRow('po-1', line, false).from_mrp).toBe(false);
  });

  test('the photo array is the line’s OWN, never shared or deduplicated', () => {
    /* One sofa build is many compartment lines sharing one build photo; folding
       them would blank every compartment but the first (mig 0274). */
    const a = poConvertLineRow('po-1', line, false);
    const b = poConvertLineRow('po-1', { ...line, soItemId: 'si-2' }, false);
    expect(a.photo_urls).toEqual(line.photoUrls);
    expect(b.photo_urls).toEqual(line.photoUrls);
  });

  test('a line with no variants still gets a row, with a null summary', () => {
    const row = poConvertLineRow('po-1', { ...line, variants: null, itemGroup: null }, false);
    expect(row.variants).toBeNull();
    expect(row.description2).toBeNull();
  });
});
