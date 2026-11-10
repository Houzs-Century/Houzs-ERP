// Owner rule 2026-11-10: a confirmed DO line keeps, for good, which PO(s) its
// goods came from and which rack(s) they left. Before this the DO detail
// re-derived both on every read (2990-DO-2611-016 had committed_po_batch_no NULL
// and its rack came from a read-time walk), so a later FIFO repair or lot relabel
// could change what an old DO printed. This is the pure per-line rule.
import { describe, expect, test } from 'vitest';
import { planShippedFrom, stampFitsLine, stampRackLabel, withReturn, withReship } from '../scripts/lib/do-shipped-from.mjs';

const AT = '2026-11-10T10:28:00.000Z';
const line = (id, item_code, qty, extra = {}) => ({ id, item_code, variant_key: '', qty, rack_id: null, goods: true, shipped_from: null, ...extra });

describe('planShippedFrom', () => {
  test('single PO and single rack: the line locks both with its qty', () => {
    const out = planShippedFrom({
      lines: [line('l1', 'CODY-(K)', 1)],
      poUnits: [{ item_code: 'CODY-(K)', variant_key: '', po: '2990-PO-2610-044', adjustment: false, qty: 1 }],
      rackOuts: [{ item_code: 'CODY-(K)', rack_id: 'r-l82', label: 'Rack L8.2', qty: 1 }],
      at: AT, src: 'ship',
    });
    expect(out.get('l1')).toEqual({
      v: 1, at: AT, src: 'ship', item_code: 'CODY-(K)', qty: 1,
      pos: [{ po: '2990-PO-2610-044', qty: 1 }], adj_qty: 0,
      racks: [{ rack_id: 'r-l82', label: 'Rack L8.2', qty: 1 }],
    });
  });

  test('one line drawing from two POs and two racks keeps the split', () => {
    const out = planShippedFrom({
      lines: [line('l1', 'MATT-Q', 5)],
      poUnits: [
        { item_code: 'MATT-Q', variant_key: '', po: 'PO-B', adjustment: false, qty: 2 },
        { item_code: 'MATT-Q', variant_key: '', po: 'PO-A', adjustment: false, qty: 3 },
      ],
      rackOuts: [
        { item_code: 'MATT-Q', rack_id: 'r1', label: 'L1.1', qty: 3 },
        { item_code: 'MATT-Q', rack_id: 'r2', label: 'L2.1', qty: 2 },
      ],
      at: AT, src: 'ship',
    }).get('l1');
    expect(out.pos).toEqual([{ po: 'PO-A', qty: 3 }, { po: 'PO-B', qty: 2 }]);
    expect(out.racks).toEqual([{ rack_id: 'r1', label: 'L1.1', qty: 3 }, { rack_id: 'r2', label: 'L2.1', qty: 2 }]);
  });

  test('two lines of one product share the pool in line order; an explicit pick takes its own rack first', () => {
    const out = planShippedFrom({
      lines: [line('l1', 'X', 2), line('l2', 'X', 1, { rack_id: 'r2' })],
      poUnits: [
        { item_code: 'X', variant_key: '', po: 'PO-1', adjustment: false, qty: 2 },
        { item_code: 'X', variant_key: '', po: 'PO-2', adjustment: false, qty: 1 },
      ],
      rackOuts: [
        { item_code: 'X', rack_id: 'r1', label: 'L1.1', qty: 2 },
        { item_code: 'X', rack_id: 'r2', label: 'L2.1', qty: 1 },
      ],
      at: AT, src: 'ship',
    });
    expect(out.get('l1').pos).toEqual([{ po: 'PO-1', qty: 2 }]);
    expect(out.get('l2').pos).toEqual([{ po: 'PO-2', qty: 1 }]);
    expect(out.get('l2').racks).toEqual([{ rack_id: 'r2', label: 'L2.1', qty: 1 }]);
    expect(out.get('l1').racks).toEqual([{ rack_id: 'r1', label: 'L1.1', qty: 2 }]);
  });

  test('a stamped line is never re-planned, and its share is gone from the pool for a line added later', () => {
    const stamped = { v: 1, at: AT, src: 'ship', item_code: 'X', qty: 2, pos: [{ po: 'PO-1', qty: 2 }], adj_qty: 0, racks: [{ rack_id: 'r1', label: 'L1.1', qty: 2 }] };
    const out = planShippedFrom({
      lines: [line('l1', 'X', 2, { shipped_from: stamped }), line('l2', 'X', 1)],
      poUnits: [
        { item_code: 'X', variant_key: '', po: 'PO-1', adjustment: false, qty: 2 },
        { item_code: 'X', variant_key: '', po: 'PO-9', adjustment: false, qty: 1 },
      ],
      rackOuts: [{ item_code: 'X', rack_id: 'r1', label: 'L1.1', qty: 2 }],
      at: AT, src: 'ship',
    });
    expect(out.has('l1')).toBe(false);
    expect(out.get('l2').pos).toEqual([{ po: 'PO-9', qty: 1 }]);
    expect(out.get('l2').racks).toEqual([]);
  });

  test('adjustment units are counted, a service line and a line with nothing known are not stamped', () => {
    const out = planShippedFrom({
      lines: [line('l1', 'GIFT', 1), line('svc', 'DELIVERY', 1, { goods: false }), line('l3', 'NOTRAIL', 1)],
      poUnits: [{ item_code: 'GIFT', variant_key: '', po: null, adjustment: true, qty: 1 }],
      rackOuts: [],
      at: AT, src: 'backfill',
    });
    expect(out.get('l1')).toMatchObject({ pos: [], adj_qty: 1, racks: [], src: 'backfill' });
    expect(out.has('svc')).toBe(false);
    expect(out.has('l3')).toBe(false);
  });

  test('the hard-bound override (BUG-103) wins over the lot FIFO ate', () => {
    const out = planShippedFrom({
      lines: [line('l1', 'JAGER-(Q)', 2)],
      poUnits: [{ item_code: 'JAGER-(Q)', variant_key: '', po: 'HC-PO-2609-187', adjustment: false, qty: 2 }],
      poOverride: new Map([['JAGER-(Q)::', ['HC-PO-009812']]]),
      rackOuts: [],
      at: AT, src: 'ship',
    });
    expect(out.get('l1').pos).toEqual([{ po: 'HC-PO-009812', qty: 2 }]);
  });
});

describe('returns and re-ship keep the locked PO and rack', () => {
  const base = { v: 1, at: AT, src: 'ship', item_code: 'X', qty: 1, pos: [{ po: 'PO-1', qty: 1 }], adj_qty: 0, racks: [] };
  test('a revert appends one return; a retried cancel with no re-ship appends nothing', () => {
    const once = withReturn(base, '2026-11-11T01:00:00Z', 'revert');
    expect(once.returns).toEqual([{ at: '2026-11-11T01:00:00Z', why: 'revert' }]);
    expect(once.pos).toEqual(base.pos);
    expect(withReturn(once, '2026-11-11T02:00:00Z', 'cancel')).toBeNull();
  });
  test('a re-ship closes the open return and leaves the core alone; a second re-ship is a no-op', () => {
    const back = withReship(withReturn(base, 't1', 'revert'), 't2');
    expect(back.returns).toEqual([{ at: 't1', why: 'revert', reshipped_at: 't2' }]);
    expect(back.pos).toEqual(base.pos);
    expect(withReship(back, 't3')).toBeNull();
    expect(withReship(base, 't3')).toBeNull();
  });
});

describe('readers', () => {
  test('a stamp for another item (line re-pointed in draft) does not fit', () => {
    const s = { v: 1, item_code: 'A', racks: [{ rack_id: 'r', label: 'L1.1', qty: 1 }], pos: [] };
    expect(stampFitsLine(s, 'A')).toBe(true);
    expect(stampFitsLine(s, 'B')).toBe(false);
    expect(stampFitsLine(null, 'A')).toBe(false);
    expect(stampFitsLine('{"v":1}', 'A')).toBe(false);
    expect(stampRackLabel(s, 'A')).toBe('L1.1');
    expect(stampRackLabel(s, 'B')).toBeNull();
  });
});
