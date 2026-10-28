/* ----------------------------------------------------------------------------
   A child document a list row can both NAME and FETCH.

   THREE THINGS ARE PINNED, and each one is invisible in a screenshot with a
   single child:

     1. A CHILD WITH NO ADDRESS IS DROPPED. The row menu prints by id, so a
        number with no id builds a menu entry that 404s. The number ARRAYS beside
        these refs must keep it — the delivery still happened — which is the
        split `so-delivery-order-nos.ts` states and this file enforces.
     2. THE ORDER MATCHES THE COLUMN ABOVE IT. The DO half deliberately does NOT
        use the generic number sort: the DO No. column orders by delivery date,
        and a menu listing the same deliveries in a different order reads as a
        different set of documents.
     3. ONE DOCUMENT IS OFFERED ONCE. A child can legitimately appear twice in a
        joined read.
   ---------------------------------------------------------------------------- */

import { describe, it, expect } from 'vitest';
import {
  refsByParent,
  soDownstreamRefs,
  NO_SO_DOWNSTREAM_REFS,
} from './downstream-doc-refs';
import { doNosBySalesOrder, type DeliveryOrderNoRow } from './so-delivery-order-nos';

const si = (o: Record<string, unknown>) => ({
  id: 'si-1', delivery_order_id: 'do-1', so_doc_no: 'SO-1', invoice_number: 'HC-SI-2608-001', ...o,
});

describe('refsByParent', () => {
  it('groups children under their parent, address beside number', () => {
    const out = refsByParent(
      [si({ id: 'a', invoice_number: 'HC-SI-2608-001' }), si({ id: 'b', invoice_number: 'HC-SI-2608-002' })],
      'delivery_order_id', 'invoice_number',
    );
    expect(out.get('do-1')).toEqual([
      { id: 'b', docNo: 'HC-SI-2608-002' },
      { id: 'a', docNo: 'HC-SI-2608-001' },
    ]);
  });

  it('DROPS a child with no id — a menu entry built from one would 404', () => {
    const out = refsByParent(
      [si({ id: null, invoice_number: 'HC-SI-2608-009' }), si({ id: 'real' })],
      'delivery_order_id', 'invoice_number',
    );
    expect(out.get('do-1')).toEqual([{ id: 'real', docNo: 'HC-SI-2608-001' }]);
  });

  it('drops a child with no parent and one with no document number', () => {
    const out = refsByParent(
      [si({ delivery_order_id: null }), si({ id: 'x', invoice_number: null }), si({ id: 'keep' })],
      'delivery_order_id', 'invoice_number',
    );
    expect([...out.keys()]).toEqual(['do-1']);
    expect(out.get('do-1')).toEqual([{ id: 'keep', docNo: 'HC-SI-2608-001' }]);
  });

  it('offers one document once, however many times the read returned it', () => {
    const out = refsByParent([si({ id: 'dup' }), si({ id: 'dup' })], 'delivery_order_id', 'invoice_number');
    expect(out.get('do-1')).toHaveLength(1);
  });

  it('orders numerically, so -10 sorts above -9 rather than below it', () => {
    const out = refsByParent(
      [si({ id: 'a', invoice_number: 'HC-SI-2608-009' }), si({ id: 'b', invoice_number: 'HC-SI-2608-010' })],
      'delivery_order_id', 'invoice_number',
    );
    expect(out.get('do-1')!.map((r) => r.docNo)).toEqual(['HC-SI-2608-010', 'HC-SI-2608-009']);
  });

  it('is stable: the same rows in a different arrival order give the same list', () => {
    const rows = [si({ id: 'a', invoice_number: 'S-1' }), si({ id: 'b', invoice_number: 'S-2' }), si({ id: 'c', invoice_number: 'S-3' })];
    const first = refsByParent(rows, 'delivery_order_id', 'invoice_number').get('do-1');
    const shuffled = refsByParent([rows[2]!, rows[0]!, rows[1]!], 'delivery_order_id', 'invoice_number').get('do-1');
    expect(shuffled).toEqual(first);
  });

  it('returns an empty map for no rows at all, never a stand-in', () => {
    expect(refsByParent(null, 'delivery_order_id', 'invoice_number').size).toBe(0);
    expect(refsByParent([], 'delivery_order_id', 'invoice_number').size).toBe(0);
  });
});

describe('soDownstreamRefs', () => {
  const doRow = (o: Partial<DeliveryOrderNoRow>): DeliveryOrderNoRow =>
    ({ id: 'do-1', so_doc_no: 'SO-1', do_number: 'DO-1', do_date: '2026-08-01', created_at: null, ...o });

  it("lists the order's deliveries in the SAME order as the DO No. column", () => {
    /* The generic number sort would put DO-2608-009 above DO-2608-004; the
       column sorts by DELIVERY DATE, and the menu has to agree with it. */
    const rows = [
      doRow({ id: 'a', do_number: 'DO-2608-009', do_date: '2026-07-02' }),
      doRow({ id: 'b', do_number: 'DO-2608-004', do_date: '2026-08-11' }),
    ];
    const refs = soDownstreamRefs(rows, [])!.get('SO-1')!.do_refs;
    expect(refs.map((r) => r.docNo)).toEqual(doNosBySalesOrder(rows).get('SO-1'));
    expect(refs.map((r) => r.docNo)).toEqual(['DO-2608-004', 'DO-2608-009']);
  });

  it('carries both children, each addressed by its own id', () => {
    const out = soDownstreamRefs(
      [doRow({ id: 'do-uuid' })],
      [si({ id: 'si-uuid', so_doc_no: 'SO-1', invoice_number: 'HC-SI-2608-007' })],
    );
    expect(out.get('SO-1')).toEqual({
      do_refs: [{ id: 'do-uuid', docNo: 'DO-1' }],
      si_refs: [{ id: 'si-uuid', docNo: 'HC-SI-2608-007' }],
    });
  });

  it('an order with only an invoice still gets an entry, with an empty delivery list', () => {
    const out = soDownstreamRefs([], [si({ so_doc_no: 'SO-9', id: 'si-9' })]);
    expect(out.get('SO-9')).toEqual({ do_refs: [], si_refs: [{ id: 'si-9', docNo: 'HC-SI-2608-001' }] });
  });

  it('an order with nothing downstream has no entry, and the shared empty says so', () => {
    expect(soDownstreamRefs([], []).get('SO-1')).toBeUndefined();
    expect(NO_SO_DOWNSTREAM_REFS).toEqual({ do_refs: [], si_refs: [] });
  });

  it('the shared empty cannot be mutated by a caller that assigns it onto a row', () => {
    // Object.assign puts the SAME array on every empty row; a push would leak.
    expect(() => NO_SO_DOWNSTREAM_REFS.do_refs.push({ id: 'x', docNo: 'y' })).toThrow();
  });
});
