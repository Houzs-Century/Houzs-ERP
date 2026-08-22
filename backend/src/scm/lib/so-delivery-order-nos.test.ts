import { describe, it, expect } from 'vitest';
import { doNosBySalesOrder, doRefsBySalesOrder, type DeliveryOrderNoRow } from './so-delivery-order-nos';

const row = (o: Partial<DeliveryOrderNoRow>): DeliveryOrderNoRow => ({
  id: 'do-uuid-1',
  so_doc_no: 'SO-1',
  do_number: 'DO-1',
  do_date: '2026-08-01',
  created_at: null,
  ...o,
});

describe('doNosBySalesOrder', () => {
  it('groups by sales order and returns every DO, newest first', () => {
    const out = doNosBySalesOrder([
      row({ so_doc_no: 'SO-1', do_number: '2990-DO-2607-001', do_date: '2026-07-02' }),
      row({ so_doc_no: 'SO-1', do_number: '2990-DO-2608-004', do_date: '2026-08-11' }),
      row({ so_doc_no: 'SO-2', do_number: '2990-DO-2607-013', do_date: '2026-07-20' }),
    ]);
    // A part-delivered order keeps BOTH — showing one of two shipments is the
    // failure this column exists to avoid.
    expect(out.get('SO-1')).toEqual(['2990-DO-2608-004', '2990-DO-2607-001']);
    expect(out.get('SO-2')).toEqual(['2990-DO-2607-013']);
  });

  it('orders same-date DOs by number so the cell does not reshuffle on reload', () => {
    const same = { so_doc_no: 'SO-1', do_date: '2026-08-11' };
    const first = doNosBySalesOrder([
      row({ ...same, do_number: 'DO-A' }),
      row({ ...same, do_number: 'DO-C' }),
      row({ ...same, do_number: 'DO-B' }),
    ]);
    const reordered = doNosBySalesOrder([
      row({ ...same, do_number: 'DO-B' }),
      row({ ...same, do_number: 'DO-A' }),
      row({ ...same, do_number: 'DO-C' }),
    ]);
    expect(first.get('SO-1')).toEqual(['DO-C', 'DO-B', 'DO-A']);
    expect(reordered.get('SO-1')).toEqual(first.get('SO-1'));
  });

  it('falls back to created_at when an imported DO carries no date', () => {
    const out = doNosBySalesOrder([
      row({ do_number: 'DO-DATED', do_date: '2026-08-01' }),
      row({ do_number: 'DO-IMPORTED', do_date: null, created_at: '2026-08-09T00:00:00Z' }),
    ]);
    expect(out.get('SO-1')).toEqual(['DO-IMPORTED', 'DO-DATED']);
  });

  it('drops rows with no sales order or no document number', () => {
    const out = doNosBySalesOrder([
      row({ so_doc_no: null }),
      row({ do_number: null }),
      row({ do_number: 'DO-REAL' }),
    ]);
    expect(out.get('SO-1')).toEqual(['DO-REAL']);
    expect(out.size).toBe(1);
  });

  it('returns no entry for an order with no delivery at all, rather than a stand-in', () => {
    // The caller renders a dash. It must never borrow the SO's own number the
    // way current_doc_no does — that is what made the old column lie.
    const out = doNosBySalesOrder([]);
    expect(out.size).toBe(0);
    expect(out.get('SO-1')).toBeUndefined();
  });
});

/* ── The ADDRESS, beside the number (owner 2026-08-22) ──────────────────────
   The Sales Order list's right-click gained "Print Delivery Order <no>", and a
   PDF is fetched by ADDRESS: `/delivery-orders-mfg/:id` is `.eq('id', id)`, so
   the numbers this file is named for can NAME a delivery order and cannot fetch
   one. `doRefsBySalesOrder` is the same grouping with the id kept.

   The two views must not diverge in ORDER — a menu that lists the deliveries in
   a different order from the column above it reads as a different set — and
   they diverge in exactly ONE way, deliberately: a row with no id is dropped
   from the refs and kept in the numbers. A number with no address can still be
   DISPLAYED; it cannot be FETCHED, and a menu entry that 404s is worse than one
   that is not offered. */
describe('doRefsBySalesOrder', () => {
  it('keeps every delivery order, in the SAME order as the numbers view', () => {
    const rows = [
      row({ id: 'a', do_number: '2990-DO-2607-001', do_date: '2026-07-02' }),
      row({ id: 'b', do_number: '2990-DO-2608-004', do_date: '2026-08-11' }),
      row({ id: 'c', do_number: '2990-DO-2607-013', do_date: '2026-07-20' }),
    ];
    expect(doRefsBySalesOrder(rows).get('SO-1')).toEqual([
      { id: 'b', docNo: '2990-DO-2608-004' },
      { id: 'c', docNo: '2990-DO-2607-013' },
      { id: 'a', docNo: '2990-DO-2607-001' },
    ]);
    expect(doRefsBySalesOrder(rows).get('SO-1')!.map((r) => r.docNo))
      .toEqual(doNosBySalesOrder(rows).get('SO-1'));
  });

  it('drops a delivery order with no id — but the NUMBERS view keeps it', () => {
    const rows = [
      row({ id: null, do_number: 'DO-NO-ADDRESS', do_date: '2026-08-12' }),
      row({ id: 'has-id', do_number: 'DO-ADDRESSABLE', do_date: '2026-08-11' }),
    ];
    expect(doRefsBySalesOrder(rows).get('SO-1')).toEqual([{ id: 'has-id', docNo: 'DO-ADDRESSABLE' }]);
    // The delivery still happened, so the column must still show it.
    expect(doNosBySalesOrder(rows).get('SO-1')).toEqual(['DO-NO-ADDRESS', 'DO-ADDRESSABLE']);
  });

  it('drops the same rows the numbers view drops — no order, no number', () => {
    const rows = [row({ so_doc_no: null }), row({ do_number: null }), row({ id: 'x', do_number: 'DO-REAL' })];
    expect(doRefsBySalesOrder(rows).get('SO-1')).toEqual([{ id: 'x', docNo: 'DO-REAL' }]);
    expect(doRefsBySalesOrder(rows).size).toBe(1);
  });

  it('returns an EMPTY list, never a stand-in, for an order with no delivery', () => {
    expect(doRefsBySalesOrder([]).size).toBe(0);
    expect(doRefsBySalesOrder([]).get('SO-1')).toBeUndefined();
  });
});
