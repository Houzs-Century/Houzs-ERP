/* Sister review G5: the PO's Linked documents list a receipt that holds one of
   its lines even when the receipt's header names another PO. */
import { describe, expect, test } from 'vitest';
import { readPoLinkedGrns, readPoLineLinkedGrnIds } from './po-grn-links';

type Row = Record<string, unknown>;
function fakeSb(tables: Record<string, Row[]>, failTable: string | null = null) {
  return {
    from: (table: string) => {
      const filters: Array<(r: Row) => boolean> = [];
      const b: Record<string, unknown> = {
        select() { return b; },
        eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return b; },
        in(col: string, vals: unknown[]) { filters.push((r) => vals.includes(r[col])); return b; },
        order() { return b; },
        range() { return b; },
        then(resolve: (v: unknown) => unknown) {
          if (table === failTable) return Promise.resolve({ data: null, error: { message: 'reset' } }).then(resolve);
          return Promise.resolve({ data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null }).then(resolve);
        },
      };
      return b;
    },
  } as never;
}

const world = {
  grns: [
    { id: 'g1', grn_number: 'GRN-1', status: 'POSTED', received_at: '2026-11-01', purchase_order_id: 'po-1' },
    { id: 'g2', grn_number: 'GRN-2', status: 'CANCELLED', received_at: '2026-11-03', purchase_order_id: 'po-2' },
  ],
  purchase_order_items: [{ id: 'poi-1', purchase_order_id: 'po-1' }, { id: 'poi-2', purchase_order_id: 'po-2' }],
  grn_items: [{ grn_id: 'g1', purchase_order_item_id: 'poi-1' }, { grn_id: 'g1', purchase_order_item_id: 'poi-2' }],
};

describe('readPoLinkedGrns', () => {
  test('the second PO on a multi-PO receipt lists that receipt, beside its own header GRNs', async () => {
    const r = await readPoLinkedGrns(fakeSb(world), 'po-2');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.grns.map((g) => g.grn_number)).toEqual(['GRN-2', 'GRN-1']);
  });

  test('the first PO lists it once, not twice', async () => {
    const r = await readPoLinkedGrns(fakeSb(world), 'po-1');
    expect(r.ok && r.grns.map((g) => g.id)).toEqual(['g1']);
  });

  test('a failed line read is reported, never an empty list', async () => {
    expect((await readPoLinkedGrns(fakeSb(world, 'grn_items'), 'po-2')).ok).toBe(false);
    expect((await readPoLineLinkedGrnIds(fakeSb(world, 'purchase_order_items'), 'po-2')).ok).toBe(false);
  });
});
