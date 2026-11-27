import { describe, expect, it } from 'vitest';
import { heldOnRack, rackMovesSummary } from './stock-transfer-racks';

const item = (item_code: string, qty: number) => ({
  id: `${item_code}-${qty}`, rack_id: 'r', item_code, product_name: null, size_label: null,
  customer_name: null, source_doc_no: null, qty, stocked_in_date: '2026-11-01', notes: null,
});

describe('heldOnRack', () => {
  it('adds every placement of the item on the rack, ignoring other items', () => {
    expect(heldOnRack({ items: [item('A', 2), item('A', 3), item('B', 9)] }, 'A')).toBe(5);
    expect(heldOnRack({ items: [] }, 'A')).toBe(0);
  });
});

describe('rackMovesSummary', () => {
  const label = (id: string) => ({ r1: 'L5.2', r2: 'CA4' }[id] ?? id);

  it('names the From and To rack of each racked line, and skips lines with no rack', () => {
    expect(rackMovesSummary([
      { itemCode: 'MAT', qty: 3, fromRackId: 'r1', toRackId: 'r2' },
      { itemCode: 'SOFA', qty: 1 },
      { itemCode: 'BED', qty: 2, toRackId: 'r2' },
      { itemCode: 'CHAIR', qty: 1, fromRackId: 'r1' },
    ], label)).toEqual([
      '3 x MAT from L5.2 to CA4',
      '2 x BED onto CA4',
      '1 x CHAIR off L5.2',
    ]);
  });

  it('a transfer with no rack has nothing to list', () => {
    expect(rackMovesSummary([{ itemCode: 'SOFA', qty: 1 }], label)).toEqual([]);
  });
});
