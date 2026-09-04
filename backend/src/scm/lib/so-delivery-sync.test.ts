import { describe, expect, it } from 'vitest';
import { emptyLiveDeliveries, isSoFullyCovered } from './so-delivery-sync';

/* The 2026-09-04 shape, pinned: three DELIVERED 2990 delivery orders carried
   line_count, money and OUT movements but ZERO rows in delivery_order_items.
   The release arm read "no rows" as "nothing delivered" and sent three
   delivered orders back to READY_TO_SHIP, where MRP re-planned goods already
   in the customers' homes. A live document with no rows is broken evidence,
   never a delivery that un-happened. */
describe('emptyLiveDeliveries', () => {
  it('names a DELIVERED document that has no line rows', () => {
    expect(emptyLiveDeliveries([
      { doNumber: '2990-DO-2607-016', status: 'DELIVERED', lineCount: 4, rowCount: 0 },
    ])).toEqual(['2990-DO-2607-016']);
  });

  it('names every shipped state, not just DELIVERED — LOADED has deducted stock since 2026-08-22', () => {
    const dos = ['LOADED', 'DISPATCHED', 'IN_TRANSIT', 'SIGNED', 'DELIVERED', 'INVOICED']
      .map((status, i) => ({ doNumber: `DO-${i}`, status, lineCount: 1, rowCount: 0 }));
    expect(emptyLiveDeliveries(dos)).toEqual(dos.map((d) => d.doNumber));
  });

  it('ignores DRAFT and CANCELLED — an empty draft is a draft, a cancelled document never counts', () => {
    expect(emptyLiveDeliveries([
      { doNumber: 'DO-D', status: 'DRAFT', lineCount: 0, rowCount: 0 },
      { doNumber: 'DO-C', status: 'CANCELLED', lineCount: 3, rowCount: 0 },
      { doNumber: 'DO-c', status: 'cancelled', lineCount: 3, rowCount: 0 },
    ])).toEqual([]);
  });

  it('is silent for a document that still has rows, whatever line_count says', () => {
    expect(emptyLiveDeliveries([
      { doNumber: 'DO-1', status: 'DELIVERED', lineCount: 0, rowCount: 6 },
      { doNumber: 'DO-2', status: 'DELIVERED', lineCount: null, rowCount: 1 },
    ])).toEqual([]);
  });

  it('flags an empty shipped document even when line_count is null — the rows are the evidence', () => {
    expect(emptyLiveDeliveries([
      { doNumber: 'DO-N', status: 'DISPATCHED', lineCount: null, rowCount: 0 },
    ])).toEqual(['DO-N']);
  });
});

/* The decision the guard sits in front of. With zero DO rows every SO line
   nets to 0, so coverage is false — which is exactly why the guard must run
   BEFORE the release arm reads that false as "un-delivered". */
describe('isSoFullyCovered against an empty delivery', () => {
  it('reads an SO with two lines and no DO rows as not covered', () => {
    expect(isSoFullyCovered(
      [{ id: 'a', qty: 1 }, { id: 'b', qty: 1 }],
      [],
    )).toBe(false);
  });

  it('reads the same SO as covered once its rows are back', () => {
    expect(isSoFullyCovered(
      [{ id: 'a', qty: 1 }, { id: 'b', qty: 1 }],
      [{ soItemId: 'a', qty: 1 }, { soItemId: 'b', qty: 1 }],
    )).toBe(true);
  });
});
