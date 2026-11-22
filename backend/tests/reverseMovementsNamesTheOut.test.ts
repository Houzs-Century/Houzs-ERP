/* A reversing IN names the OUT it undoes (migration 20261123T0100, port of Conts D15), so the FIFO trigger
   re-opens only what that OUT took from the lots. The trigger half is tests-pg/reversedShortOutLots.pg.test.ts. */
import { describe, expect, it } from 'vitest';
import { fakeSb } from '../src/scm/lib/fake-postgrest';
import { reverseMovementsCore } from '../src/scm/lib/inventory-movements';

describe('reverseMovementsCore', () => {
  it('stamps reverses_movement_id on the IN that undoes an OUT, and not on the OUT that undoes an IN', async () => {
    const sb = fakeSb({
      inventory_movements: [
        { id: 'm-out', movement_type: 'OUT', warehouse_id: 'w', item_code: 'A', variant_key: '', product_name: 'A', qty: 5, unit_cost_sen: 400, source_doc_type: 'PURCHASE_RETURN', source_doc_id: 'pr-1', source_doc_no: 'PR-1', company_id: 1 },
        { id: 'm-in', movement_type: 'IN', warehouse_id: 'w', item_code: 'B', variant_key: '', product_name: 'B', qty: 2, unit_cost_sen: 900, source_doc_type: 'PURCHASE_RETURN', source_doc_id: 'pr-1', source_doc_no: 'PR-1', company_id: 1 },
      ],
    });
    const r = await reverseMovementsCore(sb as never, 'PURCHASE_RETURN', 'pr-1', null);
    expect(r.ok).toBe(true);
    const written = (sb.tables.inventory_movements as Array<Record<string, unknown>>).filter((m) => m.id !== 'm-out' && m.id !== 'm-in');
    expect(written.find((m) => m.item_code === 'A')).toMatchObject({ movement_type: 'IN', qty: 5, reverses_movement_id: 'm-out' });
    expect(written.find((m) => m.item_code === 'B')).toMatchObject({ movement_type: 'OUT', qty: 2 });
    expect(written.find((m) => m.item_code === 'B')).not.toHaveProperty('reverses_movement_id');
  });
});
