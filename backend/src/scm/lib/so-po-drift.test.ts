
import { describe, expect, test } from 'vitest';
import { computeSoDrift } from './so-po-drift';
import type { SoWarehouseMasters } from './so-warehouse';

const masters: SoWarehouseMasters = {
  warehouses: [
    { id: 'kl', code: 'KL WAREHOUSE', name: 'KL Warehouse' },
    { id: 'pj', code: 'PJ', name: 'PJ Warehouse' },
  ],
  stateMappings: [],
};
const KL_HEADER = { sales_location: 'KL WAREHOUSE' };

describe('computeSoDrift', () => {
  test('identical lines with a NULL SO-line warehouse are NOT drift', () => {
    const line = { item_code: 'XAMMAR-2A(RHF)', item_group: 'sofa', variants: { fabricCode: 'EZ-001' } };
    expect(
      computeSoDrift({ ...line, warehouse_id: 'kl' }, { ...line, warehouse_id: null }, KL_HEADER, masters),
    ).toBeNull();
  });

  test('a real warehouse move IS drift', () => {
    const line = { item_code: 'X', item_group: 'sofa', variants: { fabricCode: 'EZ-001' } };
    const drift = computeSoDrift({ ...line, warehouse_id: 'kl' }, { ...line, warehouse_id: 'pj' }, KL_HEADER, masters);
    expect(drift?.warehouseChanged).toBe(true);
    expect(drift?.warehouseSoId).toBe('pj');
  });

  test('an item swap is flagged', () => {
    const drift = computeSoDrift(
      { item_code: 'X-1A', item_group: 'sofa', variants: { fabricCode: 'EZ-001' }, warehouse_id: 'kl' },
      { item_code: 'X-2A', item_group: 'sofa', variants: { fabricCode: 'EZ-001' }, warehouse_id: 'kl' },
      KL_HEADER,
      masters,
    );
    expect(drift?.itemChanged).toBe(true);
  });

  /* 2990-PO-2608-020 (owner 2026-09-09) — all three lines cried "source SO
     changed ... re-send to the supplier" the moment Supplier Date 2 was saved.
     The ONLY difference between the two stored variants was
     fabricSupplierCode, which the READ path stamps for display and the editor
     Save then persisted onto the PO line; the SO line never got it. Same spec,
     no drift. */
  test('a display-only fabricSupplierCode on one side alone is NOT drift', () => {
    const spec = { fabricCode: 'EZ-010', colourLabel: 'EZ-010 Silver', seatHeight: '30', legHeight: '2"' };
    expect(
      computeSoDrift(
        { item_code: 'LOTTI-1NA', item_group: 'sofa', variants: { ...spec, fabricSupplierCode: 'M2402-17' }, warehouse_id: 'kl' },
        { item_code: 'LOTTI-1NA', item_group: 'sofa', variants: spec, warehouse_id: 'kl' },
        KL_HEADER,
        masters,
      ),
    ).toBeNull();
  });

  test('a real spec change is still flagged, with the supplier code out of both messages', () => {
    const drift = computeSoDrift(
      { item_code: 'X', item_group: 'sofa', variants: { fabricCode: 'EZ-010', seatHeight: '30', fabricSupplierCode: 'M2402-17' }, warehouse_id: 'kl' },
      { item_code: 'X', item_group: 'sofa', variants: { fabricCode: 'EZ-010', seatHeight: '32' }, warehouse_id: 'kl' },
      KL_HEADER,
      masters,
    );
    expect(drift).not.toBeNull();
    expect(drift?.specPo).not.toContain('M2402-17');
    expect(drift?.specSo).not.toContain('M2402-17');
  });

  test('a spec change is flagged with the item unchanged', () => {
    const drift = computeSoDrift(
      { item_code: 'X', item_group: 'sofa', variants: { fabricCode: 'EZ-001' }, warehouse_id: 'kl' },
      { item_code: 'X', item_group: 'sofa', variants: { fabricCode: 'EZ-001', colourLabel: 'EZ-001 Pearl', fabricSupplierCode: 'M2402-1' }, warehouse_id: 'kl' },
      KL_HEADER,
      masters,
    );
    expect(drift).not.toBeNull();
    expect(drift?.itemChanged).toBe(false);
    expect(drift?.specSo).not.toBe(drift?.specPo);
  });
});
