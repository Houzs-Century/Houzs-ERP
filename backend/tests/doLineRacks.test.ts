// BUG-102 (Sim, 2026-10-10): HC-DO-2610-156 printed six racks (L10.1, L4.1,
// L5.1, L5.2, L6.1, L9.2) on both JAGER-(Q) lines although neither line's PO
// was received onto a rack. The RACK column now names only the racks the line's
// own source PO was received onto by its GRN; a GRN without a rack prints a dash.
import { describe, expect, test } from 'vitest';
import { resolveDoLineRacks, racksForDoLine } from '../src/scm/lib/do-line-racks';

type Row = Record<string, unknown>;

function fakeSb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const q = {
        select: () => q,
        in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return q; },
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
          resolve({ data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null }),
      };
      return q;
    },
  };
}

const CODE = 'JAGER-(Q)';
const tables: Record<string, Row[]> = {
  warehouse_racks: [
    { id: 'r-l4', rack: 'L4.1', warehouse_id: 'wh-1' },
    { id: 'r-l5', rack: 'L5.1', warehouse_id: 'wh-1' },
    { id: 'r-l6', rack: 'L6.1', warehouse_id: 'wh-1' },
    { id: 'r-l9', rack: 'L9.2', warehouse_id: 'wh-1' },
    { id: 'r-x1', rack: 'X1.1', warehouse_id: 'wh-2' },
  ],
  warehouse_rack_items: [
    { rack_id: 'r-l4', item_code: CODE, source_grn_id: 'grn-a' },
    { rack_id: 'r-l5', item_code: CODE, source_grn_id: 'grn-other' },
    { rack_id: 'r-l6', item_code: CODE, source_grn_id: 'grn-multi' },
    { rack_id: 'r-l9', item_code: CODE, source_grn_id: null },
    { rack_id: 'r-x1', item_code: CODE, source_grn_id: 'grn-a' },
  ],
  grn_items: [
    { grn_id: 'grn-a', item_code: CODE, rack_id: 'r-l4', purchase_order_item_id: 'poi-a' },
    { grn_id: 'grn-a', item_code: CODE, rack_id: 'r-x1', purchase_order_item_id: 'poi-a' },
    { grn_id: 'grn-b', item_code: CODE, rack_id: null, purchase_order_item_id: 'poi-b' },
    { grn_id: 'grn-other', item_code: CODE, rack_id: 'r-l5', purchase_order_item_id: 'poi-other' },
    { grn_id: 'grn-multi', item_code: CODE, rack_id: 'r-l6', purchase_order_item_id: null },
  ],
  grns: [
    { id: 'grn-a', purchase_order_id: 'po-a' },
    { id: 'grn-b', purchase_order_id: 'po-b' },
    { id: 'grn-other', purchase_order_id: 'po-other' },
    { id: 'grn-multi', purchase_order_id: 'po-c' },
  ],
  purchase_order_items: [
    { id: 'poi-a', purchase_order_id: 'po-a' },
    { id: 'poi-b', purchase_order_id: 'po-b' },
    { id: 'poi-other', purchase_order_id: 'po-other' },
  ],
  purchase_orders: [
    { id: 'po-a', po_number: 'HC-PO-2609-013' },
    { id: 'po-b', po_number: 'HC-PO-010015' },
    { id: 'po-other', po_number: 'HC-PO-2608-001' },
    { id: 'po-c', po_number: 'HC-PO-2607-044' },
  ],
};

async function racksFor(sourcePos: string[], rackId: string | null = null) {
  const items = [{ id: 'l1', item_code: CODE }];
  const r = await resolveDoLineRacks(fakeSb(tables), items, new Map([['l1', 'wh-1']]));
  return racksForDoLine(r, { warehouseId: 'wh-1', itemCode: CODE, rackId, sourcePos });
}

describe('DO line RACK column follows the source PO', () => {
  test("a line shows only the rack its own PO's GRN placed it on", async () => {
    expect(await racksFor(['HC-PO-2609-013'])).toEqual(['L4.1']);
  });

  test('a PO whose GRN recorded no rack shows nothing, not every rack holding the code', async () => {
    expect(await racksFor(['HC-PO-010015'])).toEqual([]);
  });

  test('a line with no source PO shows nothing', async () => {
    expect(await racksFor([])).toEqual([]);
  });

  test('a GRN line without a PO item link falls back to the GRN header PO', async () => {
    expect(await racksFor(['HC-PO-2607-044'])).toEqual(['L6.1']);
  });

  test('a line shipped from two POs lists both racks', async () => {
    expect(await racksFor(['HC-PO-2609-013', 'HC-PO-2608-001'])).toEqual(['L4.1', 'L5.1']);
  });

  test("the operator's picked rack wins", async () => {
    expect(await racksFor(['HC-PO-2609-013'], 'r-l9')).toEqual(['L9.2']);
  });
});
