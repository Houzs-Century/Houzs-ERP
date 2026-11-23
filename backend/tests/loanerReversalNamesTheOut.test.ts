/* Symptom: cancelling a consignment loaner whose stock-out was short put the FULL qty back into the source lots.
   Cause: reverseLoaner merged the doc's OUTs per bucket into one reversing IN, which could name no OUT, so the
   FIFO trigger (20261123T0100) opened a lot for the whole qty.
   Fix: one reversing IN per original OUT, stamped with reverses_movement_id. The trigger half (what the lot
   becomes) is tests-pg/loanerReversalShortOut.pg.test.ts. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/scm/lib/oversell-retrocost', () => ({
  reconcileUncostedAfterIn: async () => ({ reconciled: 0, affectedDoIds: [] }),
}));
vi.mock('../src/scm/lib/stock-allocation-job', () => ({ recomputeAllocationAfterSave: async () => {} }));

import { fakeSb } from '../src/scm/lib/fake-postgrest';
import { reverseLoaner } from '../src/scm/lib/consignment-loaner';

const out = (id: string, item: string, qty: number, total: number) => ({
  id, movement_type: 'OUT', warehouse_id: 'wh-src', item_code: item, variant_key: '', product_name: item,
  qty, total_cost_sen: total, source_doc_type: 'CS_DO', source_doc_id: 'cs-1', source_doc_no: 'CS-1', company_id: 1,
});

describe('reverseLoaner', () => {
  it('writes one reversing IN per original OUT, naming it, at the source warehouse', async () => {
    const sb = fakeSb({ inventory_movements: [out('m-a', 'A', 5, 2000), out('m-b', 'B', 3, 900)] });
    const errors = await reverseLoaner(sb as never, 'CS_DO', 'cs-1', 'CS-1', 'wh-src', 'wh-cons', null, 1);
    expect(errors).toEqual([]);
    const ins = (sb.tables.inventory_movements as Array<Record<string, unknown>>)
      .filter((m) => m.movement_type === 'IN');
    expect(ins).toHaveLength(2);
    expect(ins.find((m) => m.item_code === 'A')).toMatchObject({
      warehouse_id: 'wh-src', qty: 5, reverses_movement_id: 'm-a', source_doc_no: 'CS-1-CANCEL',
    });
    expect(ins.find((m) => m.item_code === 'B')).toMatchObject({
      warehouse_id: 'wh-src', qty: 3, reverses_movement_id: 'm-b', source_doc_no: 'CS-1-CANCEL',
    });
  });

  it('a second cancel writes nothing', async () => {
    const sb = fakeSb({ inventory_movements: [out('m-a', 'A', 5, 2000)] });
    await reverseLoaner(sb as never, 'CS_DO', 'cs-1', 'CS-1', 'wh-src', 'wh-cons', null, 1);
    const after = sb.tables.inventory_movements.length;
    await reverseLoaner(sb as never, 'CS_DO', 'cs-1', 'CS-1', 'wh-src', 'wh-cons', null, 1);
    expect(sb.tables.inventory_movements).toHaveLength(after);
  });
});
