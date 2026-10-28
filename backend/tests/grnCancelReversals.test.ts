import { describe, expect, test } from 'vitest';
import { buildGrnCancelReversals, type GrnCancelLine } from '../src/scm/lib/grn-cancel-reversal';

/* The two rules this mapping exists for, pinned. Both were bought by real bugs
 * and both are invisible to a typecheck: the shape compiles either way.
 *
 * It moved out of grns.ts on 2026-08-20 with PATCH /:id/cancel's conversion to
 * the PG command transaction, and a moved rule with no test is a rule that
 * quietly stops being true. docs/modules/grn.md 7c. */

const CTX = {
  warehouseId: 'wh-1',
  grnId: 'grn-1',
  grnNumber: 'GRN-2608-001',
  performedBy: 'user-1',
} as const;

const line = (over: Partial<GrnCancelLine> = {}): GrnCancelLine => ({
  purchase_order_item_id: 'poi-1',
  qty_accepted: 2,
  item_code: 'MATT-A',
  material_name: 'Mattress A',
  item_group: 'MATTRESS',
  variants: null,
  ...over,
});

describe('buildGrnCancelReversals', () => {
  test('a stock line becomes one reversing OUT on the GRN document', () => {
    const rows = buildGrnCancelReversals([line()], new Map([['poi-1', 'PO-2607-009']]), CTX);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      movement_type: 'OUT',
      warehouse_id: 'wh-1',
      item_code: 'MATT-A',
      qty: 2,
      source_doc_type: 'GRN',
      source_doc_id: 'grn-1',
      source_doc_no: 'GRN-2608-001',
      performed_by: 'user-1',
      batch_no: 'PO-2607-009',
    });
  });

  test('RULE 1: a service line is NOT reversed', () => {
    /* Without this filter the cancel writes an OUT for a freight line that
       never had an IN — a permanent negative on-hand for a non-stock SKU. */
    const rows = buildGrnCancelReversals(
      [line({ item_code: 'FREIGHT', item_group: 'SERVICE' })],
      new Map(),
      CTX,
    );
    expect(rows).toEqual([]);
  });

  test('RULE 2: each line reverses its OWN dye lot, not the last one seen', () => {
    /* Migration 0120. Two lines of the SAME product/variant received on two
       different POs: a per-bucket collapse would give both the last batch and
       deplete the wrong lot. */
    const rows = buildGrnCancelReversals(
      [line({ purchase_order_item_id: 'poi-a' }), line({ purchase_order_item_id: 'poi-b' })],
      new Map([['poi-a', 'PO-A'], ['poi-b', 'PO-B']]),
      CTX,
    );
    expect(rows.map((r) => (r as { batch_no?: string }).batch_no)).toEqual(['PO-A', 'PO-B']);
  });

  test('a manual line with no PO link carries NO batch_no, so it falls back to FIFO', () => {
    // Omitted, not null: writeMovements must not send an explicit null batch.
    const rows = buildGrnCancelReversals(
      [line({ purchase_order_item_id: null })], new Map(), CTX,
    );
    expect(rows[0]).not.toHaveProperty('batch_no');
  });

  test('a zero / null qty line writes nothing', () => {
    const rows = buildGrnCancelReversals(
      [line({ qty_accepted: 0 }), line({ qty_accepted: null })], new Map(), CTX,
    );
    expect(rows).toEqual([]);
  });
});
