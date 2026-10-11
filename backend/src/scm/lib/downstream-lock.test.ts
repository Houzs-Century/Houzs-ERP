// The owner's downstream rule, 2026-08-10, verbatim:
//   "已经转到下游的单据, AutoCount 不许取消/改动 ... 是的 我们也是要这样"
//
// AutoCount refuses to cancel or edit a document it has already transferred
// downstream. The ERP must refuse the same, or the first edit of a shipped
// order leaves the two systems permanently disagreeing — with the ERP wrong,
// because the stock has already moved.
//
// The rule had lived as four private copies inside four multi-thousand-line
// route files, where no test could reach it. These are the tests it never had.
import { describe, expect, test } from 'vitest';
import {
  downstreamVerdict,
  isEditable,
  soHasDownstream,
  poHasDownstream,
  doHasDownstream,
  grnHasDownstream,
} from './downstream-lock';

/* Minimal PostgREST stand-in. The lock only ever does
   .select(cols, {head, count}).eq().neq() and .select().eq(), so the builder
   collects predicates and answers on await. */
type Row = Record<string, unknown>;
function fakeSb(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let wantCount = false;
    const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const builder: Record<string, unknown> = {
      select(_cols?: string, opts?: { head?: boolean; count?: string }) {
        wantCount = !!opts?.count;
        return builder;
      },
      eq(col: string, val: unknown) { filters.push((r) => String(r[col]) === String(val)); return builder; },
      neq(col: string, val: unknown) { filters.push((r) => String(r[col]) !== String(val)); return builder; },
      then(resolve: (v: unknown) => unknown) {
        const rs = rows();
        return Promise.resolve(
          wantCount ? { data: null, count: rs.length, error: null } : { data: rs, error: null },
        ).then(resolve);
      },
    };
    return builder;
  };
  return { from } as never;
}

describe('downstreamVerdict — the rule itself', () => {
  test('a document with nothing downstream is free to cancel and edit', () => {
    expect(downstreamVerdict('SO', {})).toBeNull();
    expect(downstreamVerdict('SO', { deliveryOrders: 0, salesInvoices: 0 })).toBeNull();
    expect(isEditable('PO', { grns: 0 })).toBe(true);
  });

  test('ONE live child is enough to lock — the rule is not a threshold', () => {
    expect(downstreamVerdict('SO', { deliveryOrders: 1 })?.error).toBe('so_has_downstream');
    expect(downstreamVerdict('SO', { salesInvoices: 1 })?.error).toBe('so_has_downstream');
    expect(downstreamVerdict('PO', { grns: 1 })?.error).toBe('po_has_downstream');
    expect(downstreamVerdict('DO', { salesInvoices: 1 })?.error).toBe('do_has_downstream');
    expect(downstreamVerdict('DO', { deliveryReturns: 1 })?.error).toBe('do_has_downstream');
    expect(downstreamVerdict('GRN', { purchaseInvoices: 1 })?.error).toBe('grn_has_downstream');
    expect(isEditable('SO', { deliveryOrders: 1 })).toBe(false);
  });

  test('the refusal carries a sentence a salesperson can act on', () => {
    expect(downstreamVerdict('SO', { deliveryOrders: 1 })?.message)
      .toBe('SO has a Delivery Order / Sales Invoice — delete or cancel it first to edit');
    expect(downstreamVerdict('PO', { grns: 2 })?.message)
      .toBe('PO has a Goods Receipt — delete or cancel it first to edit');
  });
});

describe('a shipped Sales Order can be neither cancelled nor edited', () => {
  /* Both refusals come from the SAME call: the SO cancel path and every SO
     line-mutation path call soHasDownstream and 409 on its result. */
  test('a live Delivery Order locks the SO', async () => {
    const sb = fakeSb({
      delivery_orders: [{ id: 'do-1', so_doc_no: 'HC-SO-1', status: 'DELIVERED' }],
      sales_invoices: [],
    });
    const refusal = await soHasDownstream(sb, 'HC-SO-1');
    expect(refusal).not.toBeNull();
    expect(refusal?.error).toBe('so_has_downstream');
  });

  test('a live Sales Invoice locks the SO even with no DO', async () => {
    const sb = fakeSb({
      delivery_orders: [],
      sales_invoices: [{ id: 'si-1', so_doc_no: 'HC-SO-1', status: 'SENT' }],
    });
    expect((await soHasDownstream(sb, 'HC-SO-1'))?.error).toBe('so_has_downstream');
  });

  test('a CANCELLED child does not lock — the order is free again', async () => {
    const sb = fakeSb({
      delivery_orders: [{ id: 'do-1', so_doc_no: 'HC-SO-1', status: 'CANCELLED' }],
      sales_invoices: [{ id: 'si-1', so_doc_no: 'HC-SO-1', status: 'CANCELLED' }],
    });
    expect(await soHasDownstream(sb, 'HC-SO-1')).toBeNull();
  });

  test("another order's children do not lock this one", async () => {
    const sb = fakeSb({
      delivery_orders: [{ id: 'do-1', so_doc_no: 'HC-SO-2', status: 'DELIVERED' }],
      sales_invoices: [],
    });
    expect(await soHasDownstream(sb, 'HC-SO-1')).toBeNull();
  });
});

describe('a received Purchase Order can be neither cancelled nor edited', () => {
  test('a live GRN locks the PO', async () => {
    const sb = fakeSb({ grns: [{ id: 'g1', purchase_order_id: 'po-1', status: 'POSTED' }] });
    expect((await poHasDownstream(sb, 'po-1'))?.error).toBe('po_has_downstream');
  });

  test('a cancelled GRN leaves the PO editable', async () => {
    const sb = fakeSb({ grns: [{ id: 'g1', purchase_order_id: 'po-1', status: 'CANCELLED' }] });
    expect(await poHasDownstream(sb, 'po-1')).toBeNull();
  });
});

describe('DO and GRN', () => {
  test('an invoiced DO is locked', async () => {
    const sb = fakeSb({
      delivery_returns: [],
      sales_invoices: [{ id: 'si-1', delivery_order_id: 'do-1', status: 'SENT' }],
    });
    expect((await doHasDownstream(sb, 'do-1'))?.error).toBe('do_has_downstream');
  });

  test('an untouched DO is free', async () => {
    const sb = fakeSb({ delivery_returns: [], sales_invoices: [] });
    expect(await doHasDownstream(sb, 'do-1')).toBeNull();
  });

  /* GRN counts off grn_items.invoiced_qty / returned_qty, not a row count over
     purchase_invoices: recomputeGrnInvoiced already excludes DRAFT and
     CANCELLED invoices from that number, which a row count would not. */
  test('a GRN line with invoiced_qty > 0 locks the GRN', async () => {
    const sb = fakeSb({ grn_items: [{ grn_id: 'g1', invoiced_qty: 2, returned_qty: 0 }] });
    expect((await grnHasDownstream(sb, 'g1'))?.error).toBe('grn_has_downstream');
  });

  test('a GRN line with returned_qty > 0 locks the GRN', async () => {
    const sb = fakeSb({ grn_items: [{ grn_id: 'g1', invoiced_qty: 0, returned_qty: 1 }] });
    expect((await grnHasDownstream(sb, 'g1'))?.error).toBe('grn_has_downstream');
  });

  test('a GRN nothing has been drawn from stays editable', async () => {
    const sb = fakeSb({
      grn_items: [
        { grn_id: 'g1', invoiced_qty: 0, returned_qty: 0 },
        { grn_id: 'g1', invoiced_qty: 0, returned_qty: 0 },
      ],
    });
    expect(await grnHasDownstream(sb, 'g1')).toBeNull();
  });
});
