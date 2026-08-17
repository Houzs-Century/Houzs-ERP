// attributeUnlinkedDoLines — the PURE half of the second reading MRP and the
// DELIVERED flip now take when a shipment lost its so_item_id.
//
// The property that matters is NOT "unlinked lines get counted". It is that
// counting them can never invent coverage: an attributed unit must come out of
// the SAME order the DO header names, of the SAME SKU, and only into what the
// properly-linked deliveries left open. If that cap ever slips, this stops
// being a repair and becomes a way to hide a real shortage from Procurement —
// which is the failure the whole 2026-08-17 investigation was about, running in
// the other direction.

import { describe, it, expect } from 'vitest';
import {
  attributeUnlinkedDoLines,
  type CoverageSoLine,
  type UnlinkedDoLine,
} from '../src/scm/lib/do-unlinked-coverage';

const SO = '2990-SO-2607-012';
const soLine = (id: string, itemCode: string, qty: number, docNo = SO): CoverageSoLine =>
  ({ id, docNo, itemCode, qty });
const doLine = (id: string, itemCode: string, qty: number, docNo = SO): UnlinkedDoLine =>
  ({ id, docNo, itemCode, qty });
const totalFor = (out: ReturnType<typeof attributeUnlinkedDoLines>, soItemId: string) =>
  out.filter((a) => a.soItemId === soItemId).reduce((n, a) => n + a.qty, 0);

describe('attributeUnlinkedDoLines', () => {
  it('covers an SO line whose only delivery lost its link', () => {
    const out = attributeUnlinkedDoLines(
      [soLine('so-baron', 'BARON-(K)', 1)],
      new Map(),
      [doLine('do-1', 'BARON-(K)', 1)],
    );
    expect(out).toEqual([{ doLineId: 'do-1', soItemId: 'so-baron', qty: 1 }]);
  });

  it('attributes nothing when the real links already cover the line', () => {
    // The repair script has since re-pointed the twin. Both readings see the
    // same shipment; only one may count it.
    const out = attributeUnlinkedDoLines(
      [soLine('so-baron', 'BARON-(K)', 1)],
      new Map([['so-baron', 1]]),
      [doLine('do-1', 'BARON-(K)', 1)],
    );
    expect(out).toEqual([]);
  });

  it('fills only the gap when a line is part-delivered through a real link', () => {
    const out = attributeUnlinkedDoLines(
      [soLine('so-pillow', 'NTYR MEMORY CONTOUR PILLOW', 4)],
      new Map([['so-pillow', 3]]),
      [doLine('do-1', 'NTYR MEMORY CONTOUR PILLOW', 4)],
    );
    // Ordered 4, linked 3 → at most 1 may be attributed, never the DO line's 4.
    expect(totalFor(out, 'so-pillow')).toBe(1);
  });

  it('never crosses to another Sales Order, even for the identical SKU', () => {
    const out = attributeUnlinkedDoLines(
      [soLine('so-other', 'BARON-(K)', 1, '2990-SO-2606-019')],
      new Map(),
      [doLine('do-1', 'BARON-(K)', 1, SO)], // this DO names a different order
    );
    expect(out).toEqual([]);
  });

  it('attributes nothing for a SKU the order never carried', () => {
    const out = attributeUnlinkedDoLines(
      [soLine('so-baron', 'BARON-(K)', 1)],
      new Map(),
      [doLine('do-1', 'FREE-SAMPLE', 1)],
    );
    expect(out).toEqual([]);
  });

  it('drops the overflow rather than forcing it onto an unrelated line', () => {
    const out = attributeUnlinkedDoLines(
      [soLine('so-pillow', 'PILLOW', 2), soLine('so-baron', 'BARON-(K)', 1)],
      new Map(),
      [doLine('do-1', 'PILLOW', 5)],
    );
    expect(totalFor(out, 'so-pillow')).toBe(2); // capped at ordered
    expect(totalFor(out, 'so-baron')).toBe(0);  // never spills across SKUs
  });

  it('spills across two same-SKU lines of one order, in listing order', () => {
    const out = attributeUnlinkedDoLines(
      [soLine('so-a', 'PILLOW', 2), soLine('so-b', 'PILLOW', 2)],
      new Map(),
      [doLine('do-1', 'PILLOW', 3)],
    );
    expect(totalFor(out, 'so-a')).toBe(2);
    expect(totalFor(out, 'so-b')).toBe(1);
  });

  it('matches item codes case- and space-insensitively', () => {
    const out = attributeUnlinkedDoLines(
      [soLine('so-baron', 'BARON-(K)', 1)],
      new Map(),
      [doLine('do-1', ' baron-(k)', 1)],
    );
    expect(out).toHaveLength(1);
  });

  it('ignores a zero or negative qty on either side', () => {
    expect(attributeUnlinkedDoLines([soLine('so-1', 'X', 0)], new Map(), [doLine('do-1', 'X', 1)])).toEqual([]);
    expect(attributeUnlinkedDoLines([soLine('so-1', 'X', 1)], new Map(), [doLine('do-1', 'X', 0)])).toEqual([]);
  });

  it('is inert when there is nothing unlinked — the healthy steady state', () => {
    expect(attributeUnlinkedDoLines([soLine('so-1', 'X', 1)], new Map(), [])).toEqual([]);
  });

  it('covers the whole of 2990-DO-2608-008 against its order', () => {
    const so: Array<[string, string, number]> = [
      ['so-0', '2990 ARRUS-SOFT MATT (K)', 1],
      ['so-1', '2990 ARRUS-SOFT MATT (Q)', 1],
      ['so-2', 'BARON-(K)', 1],
      ['so-3', '2990S WP MP (K)', 1],
      ['so-4', 'NTYR MEMORY CONTOUR PILLOW', 4],
      ['so-5', '2990S WP MP (Q)', 1],
      ['so-6', 'SVC-DELIVERY-CROSS', 1],
    ];
    const out = attributeUnlinkedDoLines(
      so.map(([id, code, qty]) => soLine(id, code, qty)),
      new Map(),
      so.map(([id, code, qty]) => doLine(`do-${id}`, code, qty)),
    );
    // Every line fully covered → the order reads DELIVERED and leaves MRP.
    for (const [id, , qty] of so) expect(totalFor(out, id)).toBe(qty);
  });
});
