// Unit tests for the DO cancel-path add-back ROW BUILDER (buildDoReversalRows).
//
// SCOPE + HONEST LIMIT: the AUTHORITATIVE R4 reversal — restoring the DO's
// ORIGINAL lots at their ORIGINAL per-lot cost, DELETING its
// inventory_lot_consumptions rows, and the idempotent re-cancel no-op — lives in
// the SQL function scm.fn_reverse_do_out (migration 0198). That function is NOT
// exercised here: this repo's suite binds no Postgres, so the trigger/function
// firing is only provable against a real DB (staging apply, owner-run). These
// tests pin the PURE JS decisions the route makes AROUND that fn: which buckets
// the route still writes (none, when the fn handled them) and the legacy
// average-cost fallback used only when the fn is absent/errors.
import { describe, expect, test } from 'vitest';
import { buildDoReversalRows, type DoReversalMovement } from './do-reversal';

const ctx = (over: Partial<Parameters<typeof buildDoReversalRows>[1]> = {}) => ({
  deliveryOrderId: 'do-1',
  doNo: 'DO-2607-001',
  performedBy: 'user-1',
  dropshipBatchedHandled: false,
  nonDropshipHandled: false,
  ...over,
});

const out = (over: Partial<DoMov> = {}): DoReversalMovement => ({
  movement_type: 'OUT', warehouse_id: 'wh-1', product_code: 'CHAIR-A',
  variant_key: '', batch_no: null, qty: 5, total_cost_sen: 1000, product_name: 'Chair A',
  ...over,
});
type DoMov = DoReversalMovement;

describe('buildDoReversalRows — SQL fn already handled the DO', () => {
  test('non-drop-ship: nonDropshipHandled skips EVERY bucket (fn_reverse_do_out did it)', () => {
    const rows = buildDoReversalRows(
      [out({ batch_no: null }), out({ batch_no: 'DYE-77', product_code: 'SOFA-X' })],
      ctx({ nonDropshipHandled: true }),
    );
    expect(rows).toEqual([]);
  });

  test('drop-ship: dropshipBatchedHandled skips only BATCHED buckets, keeps plain', () => {
    const rows = buildDoReversalRows(
      [
        out({ batch_no: 'DYE-77', product_code: 'SOFA-X', qty: 2, total_cost_sen: 400 }),
        out({ batch_no: null, product_code: 'CHAIR-A', qty: 5, total_cost_sen: 1000 }),
      ],
      ctx({ dropshipBatchedHandled: true }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ product_code: 'CHAIR-A', movement_type: 'ADJUSTMENT' });
  });
});

describe('buildDoReversalRows — legacy fallback (SQL fn absent / errored)', () => {
  test('plain bucket -> positive ADJUSTMENT at average consumed cost, no batch_no', () => {
    const rows = buildDoReversalRows([out({ qty: 4, total_cost_sen: 1000 })], ctx());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      movement_type: 'ADJUSTMENT',
      product_code: 'CHAIR-A',
      qty: 4,
      unit_cost_sen: 250, // round(1000 / 4)
      source_doc_type: 'ADJUSTMENT',
      source_doc_id: 'do-1',
      source_doc_no: 'DO-2607-001',
    });
    expect('batch_no' in rows[0]).toBe(false);
  });

  test('sofa (batched) bucket -> reversing IN carrying the exact batch_no', () => {
    const rows = buildDoReversalRows(
      [out({ product_code: 'SOFA-X', batch_no: 'DYE-77', qty: 3, total_cost_sen: 999 })],
      ctx(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      movement_type: 'IN',
      product_code: 'SOFA-X',
      batch_no: 'DYE-77',
      qty: 3,
      unit_cost_sen: 333, // round(999 / 3)
    });
  });

  test('average cost rounds (out_total_cost / out_qty)', () => {
    const rows = buildDoReversalRows([out({ qty: 3, total_cost_sen: 1000 })], ctx());
    expect(rows[0].unit_cost_sen).toBe(333); // round(333.33)
  });

  test('an edited DO nets OUT minus its own IN deltas per bucket', () => {
    // shipped 5, then a line edit resynced 2 back (delta IN) -> reverse net 3.
    const rows = buildDoReversalRows(
      [
        out({ qty: 5, total_cost_sen: 1000 }),
        out({ movement_type: 'IN', qty: 2, total_cost_sen: 0 }),
      ],
      ctx(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].qty).toBe(3);
  });

  test('a bucket fully returned before cancel (net_out = 0) writes no row', () => {
    const rows = buildDoReversalRows(
      [out({ qty: 5 }), out({ movement_type: 'IN', qty: 5 })],
      ctx(),
    );
    expect(rows).toEqual([]);
  });

  test('plain and sofa buckets of the same DO are reversed independently', () => {
    const rows = buildDoReversalRows(
      [
        out({ product_code: 'CHAIR-A', batch_no: null, qty: 4, total_cost_sen: 800 }),
        out({ product_code: 'SOFA-X', batch_no: 'DYE-77', qty: 2, total_cost_sen: 500 }),
      ],
      ctx(),
    );
    expect(rows).toHaveLength(2);
    const chair = rows.find((r) => r.product_code === 'CHAIR-A');
    const sofa = rows.find((r) => r.product_code === 'SOFA-X');
    expect(chair).toMatchObject({ movement_type: 'ADJUSTMENT', unit_cost_sen: 200 });
    expect(sofa).toMatchObject({ movement_type: 'IN', batch_no: 'DYE-77', unit_cost_sen: 250 });
  });

  test('no movements -> no rows (nothing to reverse)', () => {
    expect(buildDoReversalRows([], ctx())).toEqual([]);
  });

  test('drop-ship fallback (fn errored): batched bucket still gets a legacy IN', () => {
    const rows = buildDoReversalRows(
      [out({ product_code: 'SOFA-X', batch_no: 'DYE-77', qty: 2, total_cost_sen: 400 })],
      ctx({ dropshipBatchedHandled: false }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ movement_type: 'IN', batch_no: 'DYE-77' });
  });
});
