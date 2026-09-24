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
  soWarehouseIdForDoc,
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

// Regression (HC-SO-013495): every company has its own "KL WAREHOUSE". The
// amendment ADD line resolved the header's sales_location against EVERY
// company's warehouses and took the first name match — another company's KL —
// so the Houzs MRP showed "—" for those lines and split the order into two POs.
describe('soWarehouseIdForDoc — resolves inside the SO own company only', () => {
  type Row = Record<string, unknown>;
  const tables: Record<string, Row[]> = {
    mfg_sales_orders: [
      { doc_no: 'HC-SO-1', company_id: 1, sales_location: 'KL WAREHOUSE', customer_state: 'Selangor' },
    ],
    warehouses: [
      { id: 'kl-2990', code: 'KL WAREHOUSE', name: 'KL WAREHOUSE', company_id: 2 },
      { id: 'kl-houzs', code: 'KL WAREHOUSE', name: 'KL WAREHOUSE', company_id: 1 },
    ],
    state_warehouse_mappings: [],
  };
  const fakeSb = {
    from(table: string) {
      let rows = tables[table] ?? [];
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => { rows = rows.filter((r) => r[col] === val); return q; },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (res: (v: { data: Row[]; error: null }) => unknown) => res({ data: rows, error: null }),
      };
      return q;
    },
  };

  test('picks the warehouse of the SO company, not the first name match', async () => {
    expect(await soWarehouseIdForDoc(fakeSb, 'HC-SO-1', 1)).toBe('kl-houzs');
  });

  test('an unknown company resolves to null instead of reading every company', async () => {
    expect(await soWarehouseIdForDoc(fakeSb, 'HC-SO-1', null)).toBeNull();
  });
});
