import { describe, expect, test } from 'vitest';

// @ts-expect-error — plain .mjs repair script; only its pure planner is imported.
import { planRepair } from '../scripts/repair-over-received-po-lines.mjs';

/* The planner behind repair-over-received-po-lines.mjs, driven with the exact
 * shape production carries. The fixture below is HC-PO-009018 / HC-GR-004913 as
 * the production read reported it: four PO lines that each ORDERED 1, one single
 * POSTED migrated GRN posting 2 against every one of them, and no inventory
 * movement behind it. */

const grn = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'gi-1',
  grnId: 'g-1',
  grnNumber: 'HC-GR-004913',
  status: 'POSTED',
  migrated: true,
  qtyAccepted: 2,
  qtyReceived: 2,
  qtyRejected: 0,
  returnedQty: 0,
  movements: 0,
  ...over,
});

const line = (over: Partial<Record<string, unknown>> = {}) => ({
  poItemId: 'poi-1',
  poNumber: 'HC-PO-009018',
  materialCode: '9028-1A(RHF)',
  qty: 1,
  receivedQty: 2,
  unitPriceCenti: 150_00,
  grnLines: [grn()],
  ...over,
});

describe('over-received repair planner', () => {
  test('the production shape: received 2 against an ordered 1 is clamped on BOTH sides', () => {
    const { repair, skip } = planRepair([line()]);
    expect(skip).toHaveLength(0);
    expect(repair).toHaveLength(1);
    const r = repair[0]!;
    // The PO counter comes down...
    expect(r.fromReceived).toBe(2);
    expect(r.toReceived).toBe(1);
    expect(r.unitsRemoved).toBe(1);
    // ...and so does the GRN line that mirrors it. Fixing only one of the two
    // would leave recomputePoReceived to re-inflate the counter on the next
    // touch of this PO line.
    expect(r.fromAccepted).toBe(2);
    expect(r.toAccepted).toBe(1);
    expect(r.toQtyReceived).toBe(1);
    expect(r.toLineTotalCenti).toBe(150_00);
  });

  test('all four lines of HC-PO-009018 repair to 1 each, removing 4 excess units', () => {
    const codes = ['9028-1A(RHF)', '9028-1NA', '9028-1A(LHF)', '9028-STOOL'];
    const lines = codes.map((c, i) =>
      line({ poItemId: `poi-${i}`, materialCode: c, grnLines: [grn({ id: `gi-${i}` })] }),
    );
    const { repair, skip } = planRepair(lines);
    expect(repair).toHaveLength(4);
    expect(skip).toHaveLength(0);
    expect(repair.reduce((s: number, r: { unitsRemoved: number }) => s + r.unitsRemoved, 0)).toBe(4);
    expect(repair.every((r: { toReceived: number }) => r.toReceived === 1)).toBe(true);
  });

  test('REFUSES to clamp a document whose stock actually moved', () => {
    /* Correcting a document quantity and reversing an inventory movement are
       different acts. If a movement exists the clamp is the wrong instrument,
       so the line is reported instead of written. */
    const { repair, skip } = planRepair([line({ grnLines: [grn({ movements: 3, migrated: false })] })]);
    expect(repair).toHaveLength(0);
    expect(skip).toHaveLength(1);
    expect(skip[0]!.reason).toBe('grn_has_inventory_movements');
  });

  test('REFUSES an ambiguous split across two live GRN lines', () => {
    const { repair, skip } = planRepair([
      line({ receivedQty: 4, grnLines: [grn({ id: 'a' }), grn({ id: 'b', grnNumber: 'HC-GR-2' })] }),
    ]);
    expect(repair).toHaveLength(0);
    expect(skip[0]!.reason).toBe('multiple_live_grn_lines');
  });

  test('REFUSES a counter with no live receipt behind it', () => {
    const { repair, skip } = planRepair([line({ grnLines: [] })]);
    expect(repair).toHaveLength(0);
    expect(skip[0]!.reason).toBe('no_live_grn_line');

    // A CANCELLED GRN is not a live receipt either.
    const cancelled = planRepair([line({ grnLines: [grn({ status: 'CANCELLED' })] })]);
    expect(cancelled.skip[0]!.reason).toBe('no_live_grn_line');
  });

  test('IDEMPOTENT — re-running over already-repaired rows plans no write', () => {
    const repaired = line({ receivedQty: 1, grnLines: [grn({ qtyAccepted: 1, qtyReceived: 1 })] });
    const { repair, skip } = planRepair([repaired]);
    expect(repair).toHaveLength(0);
    expect(skip[0]!.reason).toBe('already_correct');
  });

  test('a partial receipt with a return keeps the return whole', () => {
    /* live contribution = qty_accepted - returned_qty, so restoring "1 received"
       on a line that had 1 returned means accepted 2, not accepted 1. */
    const { repair } = planRepair([
      line({ receivedQty: 3, grnLines: [grn({ qtyAccepted: 3, qtyReceived: 3, returnedQty: 1 })] }),
    ]);
    expect(repair[0]!.toReceived).toBe(1);
    expect(repair[0]!.toAccepted).toBe(2);
  });

  test('a rejected quantity is preserved in qty_received', () => {
    const { repair } = planRepair([
      line({ grnLines: [grn({ qtyAccepted: 2, qtyReceived: 3, qtyRejected: 1 })] }),
    ]);
    expect(repair[0]!.toAccepted).toBe(1);
    expect(repair[0]!.toQtyReceived).toBe(2); // 1 accepted + 1 rejected
  });
});
