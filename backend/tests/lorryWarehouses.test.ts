import { describe, expect, it } from 'vitest';
import { idOrNull, lorryWarehouseColumns } from '../src/scm/lib/lorry-warehouses';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe("a lorry's warehouses", () => {
  it('the home warehouse is chosen on its own and always in the set it serves', () => {
    expect(lorryWarehouseColumns({ homeWarehouseId: B, warehouseIds: [A] })).toEqual({ warehouse_id: B, warehouse_ids: [B, A] });
  });
  it('without a home choice the first ticked stays home, as before', () => {
    expect(lorryWarehouseColumns({ warehouseIds: [A, B] })).toEqual({ warehouse_id: A, warehouse_ids: [A, B] });
  });
  it('clearing the home keeps the set it serves', () => {
    expect(lorryWarehouseColumns({ homeWarehouseId: null, warehouseIds: [A] })).toEqual({ warehouse_id: null, warehouse_ids: [A] });
  });
});

describe('an id field', () => {
  it('takes a uuid, clears on blank, refuses anything else', () => {
    expect(idOrNull(A)).toEqual({ ok: true, value: A });
    expect(idOrNull('')).toEqual({ ok: true, value: null });
    expect(idOrNull(null)).toEqual({ ok: true, value: null });
    expect(idOrNull('DRV-004')).toEqual({ ok: false });
  });
});
