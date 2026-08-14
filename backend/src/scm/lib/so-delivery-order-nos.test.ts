import { describe, it, expect } from 'vitest';
import { doNosBySalesOrder, type DeliveryOrderNoRow } from './so-delivery-order-nos';

const row = (o: Partial<DeliveryOrderNoRow>): DeliveryOrderNoRow => ({
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
