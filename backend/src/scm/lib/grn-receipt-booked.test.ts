// GRN post re-entry guard: "already booked" is the NET receipt (IN minus the
// GRN's own reversing OUTs), not "any IN row exists". A receipt that a cancel or
// line-delete reversal took back out used to read as booked, so a post of that
// GRN skipped its stock IN for good. A failed read must refuse, never read as
// "nothing booked" (that books the stock twice).
import { describe, expect, it } from 'vitest';
import { grnReceiptBooked, netReceiptQty } from './grn-receipt-booked';

type Row = { source_doc_type: string; source_doc_id: string; movement_type: string; qty: number | string };

function fakeSb(rows: Row[], fail: string | null = null) {
  return {
    from(table: string) {
      expect(table).toBe('inventory_movements');
      const filters: Array<[string, string]> = [];
      const q = {
        select() { return q; },
        eq(col: string, val: string) { filters.push([col, val]); return q; },
        then(ok: (r: unknown) => unknown, bad?: (e: unknown) => unknown) {
          if (fail) return Promise.resolve({ data: null, error: { message: fail } }).then(ok, bad);
          const data = rows
            .filter((r) => filters.every(([c, v]) => (r as Record<string, unknown>)[c] === v))
            .map((r) => ({ movement_type: r.movement_type, qty: r.qty }));
          return Promise.resolve({ data, error: null }).then(ok, bad);
        },
      };
      return q;
    },
  };
}

const IN = (qty: number | string, id = 'g1'): Row => ({ source_doc_type: 'GRN', source_doc_id: id, movement_type: 'IN', qty });
const OUT = (qty: number | string, id = 'g1'): Row => ({ source_doc_type: 'GRN', source_doc_id: id, movement_type: 'OUT', qty });

describe('grnReceiptBooked', () => {
  it('no movements: not booked', async () => {
    expect(await grnReceiptBooked(fakeSb([]), 'g1')).toEqual({ ok: true, booked: false, netIn: 0 });
  });

  it('a standing receipt is booked (re-entry on a POSTED GRN stays a no-op)', async () => {
    const r = await grnReceiptBooked(fakeSb([IN(3), IN(2)]), 'g1');
    expect(r).toEqual({ ok: true, booked: true, netIn: 5 });
  });

  it('a receipt fully reversed by its cancel OUTs is NOT booked (the bug: the IN row alone read as booked)', async () => {
    const r = await grnReceiptBooked(fakeSb([IN(3), IN(2), OUT(3), OUT(2)]), 'g1');
    expect(r).toEqual({ ok: true, booked: false, netIn: 0 });
  });

  it('a partly reversed receipt (one line deleted) is still booked', async () => {
    const r = await grnReceiptBooked(fakeSb([IN(3), IN(2), OUT(2)]), 'g1');
    expect(r).toEqual({ ok: true, booked: true, netIn: 3 });
  });

  it('only this GRN counts; another GRN and other source types are ignored', async () => {
    const rows: Row[] = [IN(4, 'g2'), { source_doc_type: 'DO', source_doc_id: 'g1', movement_type: 'OUT', qty: 9 }, IN(1)];
    expect(await grnReceiptBooked(fakeSb(rows), 'g1')).toEqual({ ok: true, booked: true, netIn: 1 });
  });

  it('numeric qty returned as text (transaction client) still sums as numbers', async () => {
    expect(await grnReceiptBooked(fakeSb([IN('1'), IN('1'), OUT('1')]), 'g1')).toEqual({ ok: true, booked: true, netIn: 1 });
  });

  it('a failed read refuses instead of answering "nothing booked"', async () => {
    const r = await grnReceiptBooked(fakeSb([IN(3)], 'connection reset'), 'g1');
    expect(r).toEqual({ ok: false, error: { message: 'connection reset' } });
  });
});

describe('netReceiptQty', () => {
  it('ignores rows that are neither IN nor OUT and non-numeric qty', () => {
    expect(netReceiptQty([{ movement_type: 'IN', qty: 2 }, { movement_type: 'ADJUSTMENT', qty: 5 }, { movement_type: 'OUT', qty: 'x' }])).toBe(2);
  });
});
