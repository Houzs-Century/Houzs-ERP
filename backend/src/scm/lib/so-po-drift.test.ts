// so-po-drift — the SO→PO drift arms, and specifically the warehouse arm that
// used to cry a false "SO warehouse moved" on a line whose SO source carries a
// NULL warehouse (it inherits the header). Bug 0539.

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
  // THE REGRESSION. PO line bound to KL; SO line never set a per-line warehouse
  // and inherits the KL header. The old raw compare (KL !== NULL) flagged a move.
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

  // The exact shape that showed on PO-2608-026's hand-added line: SO carries the
  // full fabric label, the PO line only the bare code.
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
