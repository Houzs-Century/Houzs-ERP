/* 2026-10-26: the board re-downloaded 5.4 MB on every edit, 72% of it Delivered
   rows. state=OPEN leaves them out and carries their per-region count. */
import { describe, expect, it } from 'vitest';
import { boardSlice } from './delivery-board-slice';

const rows = [
  { id: 1, delivery_state: 'PENDING_SCHEDULE', regions: ['KL'] },
  { id: 2, delivery_state: 'DELIVERED', regions: ['KL'] },
  { id: 3, delivery_state: 'DELIVERED', regions: ['KL', 'NORTHERN'] },
  { id: 4, delivery_state: 'OVERDUE', regions: ['NORTHERN'] },
];

describe('boardSlice', () => {
  it('OPEN drops Delivered rows and counts them per region', () => {
    const s = boardSlice(rows, 'OPEN');
    expect(s.orders.map((o) => o.id)).toEqual([1, 4]);
    expect(s.deliveredByRegion).toEqual({ KL: 2, NORTHERN: 1 });
  });
  it('ALL and a single state behave as before', () => {
    expect(boardSlice(rows, 'ALL').orders).toHaveLength(4);
    expect(boardSlice(rows, 'DELIVERED').orders.map((o) => o.id)).toEqual([2, 3]);
    expect(boardSlice(rows, 'ALL').deliveredByRegion).toBeNull();
  });
});
