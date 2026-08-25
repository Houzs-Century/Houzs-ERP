// ----------------------------------------------------------------------------
// so-warehouse — the warehouse follows the Sales Order, and a NULL line
// warehouse INHERITS the header rather than meaning "moved".
//
// Regression (bug 0539): the PO SO-drift check compared a PO line's real
// warehouse against the SO line's RAW warehouse_id with `!==`. A rebuilt SO's
// lines carry warehouse_id NULL (they inherit the header's sales_location), so
// `KL-uuid !== NULL` fired "SO warehouse moved" on every such line. The fix
// resolves the SO line to its EFFECTIVE warehouse first (resolveLineWarehouseId)
// and only flags a genuine difference between two real warehouses
// (warehousesDiffer). These tests pin both halves — the second set is RED on the
// pre-fix tree, where a real id against NULL compared unequal.
// ----------------------------------------------------------------------------

import { describe, expect, test } from 'vitest';
import {
  resolveSoWarehouseId,
  resolveLineWarehouseId,
  warehousesDiffer,
  type SoWarehouseMasters,
} from './so-warehouse';

const masters: SoWarehouseMasters = {
  warehouses: [
    { id: 'kl', code: 'KL WAREHOUSE', name: 'KL Warehouse' },
    { id: 'pj', code: 'PJ', name: 'PJ Warehouse' },
  ],
  stateMappings: [
    { state: 'Kuala Lumpur', warehouse_id: 'kl' },
    { state: 'Selangor', warehouse_id: 'pj' },
  ],
};

describe('resolveSoWarehouseId — the order header carries the warehouse', () => {
  test('sales_location code resolves to the warehouse', () => {
    expect(resolveSoWarehouseId({ sales_location: 'KL WAREHOUSE' }, masters)).toBe('kl');
  });

  test('falls back to customer_state mapping when sales_location is empty', () => {
    expect(resolveSoWarehouseId({ sales_location: null, customer_state: 'Selangor' }, masters)).toBe('pj');
  });

  test('null when the header carries neither', () => {
    expect(resolveSoWarehouseId({ sales_location: null, customer_state: null }, masters)).toBeNull();
  });
});

describe('resolveLineWarehouseId — a NULL line inherits the order, it has not moved', () => {
  test("the line's own warehouse wins when it has one", () => {
    expect(resolveLineWarehouseId('pj', { sales_location: 'KL WAREHOUSE' }, masters)).toBe('pj');
  });

  test('a NULL line resolves to the header warehouse (the fix)', () => {
    expect(resolveLineWarehouseId(null, { sales_location: 'KL WAREHOUSE' }, masters)).toBe('kl');
  });

  test('null when neither the line nor the header names a warehouse', () => {
    expect(resolveLineWarehouseId(null, { sales_location: null, customer_state: null }, masters)).toBeNull();
  });
});

describe('warehousesDiffer — only a real, distinct pair counts as drift', () => {
  // THE REGRESSION. A real PO warehouse against a NULL SO side is NOT a move —
  // the pre-fix `poWh !== soWh` returned true here and printed the false warning.
  test('a real warehouse against NULL is NOT drift', () => {
    expect(warehousesDiffer('kl', null)).toBe(false);
    expect(warehousesDiffer(null, 'kl')).toBe(false);
  });

  test('two NULLs are not drift', () => {
    expect(warehousesDiffer(null, null)).toBe(false);
  });

  test('the same warehouse is not drift', () => {
    expect(warehousesDiffer('kl', 'kl')).toBe(false);
  });

  test('two different real warehouses ARE drift', () => {
    expect(warehousesDiffer('kl', 'pj')).toBe(true);
  });
});
