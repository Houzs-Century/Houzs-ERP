// A conversion must name the lines it actually took — the tests for
// autocount-convert-lines.ts.
//
// SPLIT OUT OF autocount-outbox.test.ts on 2026-08-18 with the module they
// cover, when the merged-conversion tests pushed that file over the 2,000-line
// cap. The harness below is deliberately the SMALL half of the original: these
// tests need a toggle, an outbox and two sales-order line tables, and nothing
// else.
//
// What they pin, in one sentence: `enqueueConvert` sends `DtlKeys` naming the
// lines the ERP moved, and where it cannot name them it REFUSES rather than
// letting AcSyncService fall back to every still-outstanding line on the source.
import { describe, expect, test, beforeEach } from 'vitest';
import { enqueueConvert } from './autocount-outbox';
import { resetWritebackFlagCache } from './autocount-writeback-flag';
import { fakeSb, type Row } from './fake-postgrest';

/* A sales order that names nobody is REFUSED (FK_SO_SalesAgent), so every
   fixture is attributed — the same default the sibling suite runs under. */
const SALESPERSON = { id: 'staff-1', name: 'Nurul Hidayah' };

const withFlag = (value: string | null, extra: Record<string, Row[]> = {}) =>
  fakeSb({
    app_config: value == null ? [] : [{ key: 'scm.autocount_writeback', value }],
    autocount_outbox: [],
    staff: [{ ...SALESPERSON }],
    mfg_sales_orders: [
      { doc_no: 'HC-SO-9', company_id: 1, salesperson_id: SALESPERSON.id, sales_location: 'KL' },
      { doc_no: 'HC-SO-10', company_id: 1, salesperson_id: SALESPERSON.id, sales_location: 'KL' },
    ],
    delivery_orders: [{ id: 'do-1', linked_ac_docno: null }],
    ...extra,
  });

const outbox = (sb: { tables: Record<string, Row[]> }) => sb.tables.autocount_outbox ?? [];

beforeEach(() => resetWritebackFlagCache());

/* ── A CONVERSION MUST NAME THE LINES IT TOOK ────────────────────────────────
   The defect these pin: enqueueConvert sent no DtlKeys, so AcSyncService fell
   through to DtlKeys() and transferred EVERY still-outstanding line on the
   parent (AcSyncService.cs:382-411). A delivery order shipping 2 of a sales
   order's 5 lines therefore produced an AutoCount DO of all 5 — stock moving in
   a live account book that never moved here. Partial shipment is the daily
   case, so this is not an edge condition. */
describe('a partial conversion transfers only the lines it actually took', () => {
  const soLines = (keys: Array<number | null>) => keys.map((k, i) => ({
    id: `so-item-${i + 1}`, doc_no: 'HC-SO-9', item_code: `SKU-${i + 1}`,
    qty: 1, unit_price_centi: 100, linked_ac_dtlkey: k, cancelled: false,
  }));

  const convertDo = (sb: unknown) => enqueueConvert(sb as never, {
    companyId: 1,
    op: 'so_to_do',
    from: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
    to: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
    docType: 'DO',
    docNo: 'HC-DO-1',
    docId: 'do-1',
  });

  test('two of three lines ship -> DtlKeys names exactly those two', async () => {
    const sb = withFlag('1', {
      mfg_sales_order_items: soLines([9001, 9002, 9003]),
      delivery_order_items: [
        { id: 'do-item-1', delivery_order_id: 'do-1', so_item_id: 'so-item-1', item_code: 'SKU-1' },
        { id: 'do-item-2', delivery_order_id: 'do-1', so_item_id: 'so-item-2', item_code: 'SKU-2' },
      ],
    });
    expect(await convertDo(sb)).toBe(true);
    const [row] = outbox(sb);
    expect(row.status).toBe('pending');
    expect(row.payload.body.DtlKeys).toEqual([9001, 9002]);
    /* The whole point: the third line's key is NOT in the payload, so AutoCount
       cannot transfer goods the ERP did not ship. */
    expect(row.payload.body.DtlKeys).not.toContain(9003);
  });

  test('a PARTIAL transfer whose source line has no key is REFUSED, not sent blind', async () => {
    const sb = withFlag('1', {
      /* so-item-2 was never keyed, and the DO leaves so-item-3 behind. */
      mfg_sales_order_items: soLines([9001, null, 9003]),
      delivery_order_items: [
        { id: 'do-item-1', delivery_order_id: 'do-1', so_item_id: 'so-item-1', item_code: 'SKU-1' },
        { id: 'do-item-2', delivery_order_id: 'do-1', so_item_id: 'so-item-2', item_code: 'SKU-2' },
      ],
    });
    expect(await convertDo(sb)).toBe(true);
    const [row] = outbox(sb);
    expect(row.status).toBe('skipped');
    expect(row.last_error).toContain('cannot name the subset');
    /* A refusal must not also queue the wrong thing. */
    expect(outbox(sb).filter((r) => r.status === 'pending')).toHaveLength(0);
  });

  test('a WHOLE-document transfer with no keys falls back rather than blocking the shipment', async () => {
    const sb = withFlag('1', {
      mfg_sales_order_items: soLines([null, null]),
      delivery_order_items: [
        { id: 'do-item-1', delivery_order_id: 'do-1', so_item_id: 'so-item-1', item_code: 'SKU-1' },
        { id: 'do-item-2', delivery_order_id: 'do-1', so_item_id: 'so-item-2', item_code: 'SKU-2' },
      ],
    });
    expect(await convertDo(sb)).toBe(true);
    const [row] = outbox(sb);
    expect(row.status).toBe('pending');
    /* "All outstanding" and "the lines we took" are the same set here, and the
       account book is the better authority on which are still open. */
    expect(row.payload.body.DtlKeys).toBeUndefined();
  });

  test('a cancelled parent line is not a line this conversion left behind', async () => {
    const sb = withFlag('1', {
      mfg_sales_order_items: [
        ...soLines([9001, 9002]),
        {
          id: 'so-item-3', doc_no: 'HC-SO-9', item_code: 'SKU-3', qty: 1,
          unit_price_centi: 100, linked_ac_dtlkey: null, cancelled: true,
        },
      ],
      delivery_order_items: [
        { id: 'do-item-1', delivery_order_id: 'do-1', so_item_id: 'so-item-1', item_code: 'SKU-1' },
        { id: 'do-item-2', delivery_order_id: 'do-1', so_item_id: 'so-item-2', item_code: 'SKU-2' },
      ],
    });
    expect(await convertDo(sb)).toBe(true);
    const [row] = outbox(sb);
    expect(row.payload.body.DtlKeys).toEqual([9001, 9002]);
  });

  /* ── PARTIALITY IS PER PARENT, and a merge is what makes that reachable ──
     `conversionIsPartial` decides whether an un-nameable subset is safe to
     degrade into "transfer everything outstanding". It used to read the parent
     of the FIRST taken line and compare THAT document's line count against the
     total taken from ALL of them, which only ever saw one parent because only
     single-source conversions could enqueue.

     Two sales orders of two lines each, three shipped, and one of the three
     carrying no DtlKey: the first parent holds 2 and the caller took 3, so
     `2 > 3` is false, the transfer reads as whole-document, no DtlKeys are sent
     — and AutoCount moves every outstanding line on BOTH orders, including the
     fourth, which is still in the warehouse. Counted per parent it is partial,
     and a partial transfer the ERP cannot name is refused. */
  test('a MERGE that leaves one parent line behind is partial, and an unnameable subset is REFUSED', async () => {
    const sb = withFlag('1', {
      mfg_sales_order_items: [
        { id: 'a-1', doc_no: 'HC-SO-9', item_code: 'SKU-1', qty: 1, unit_price_centi: 100, linked_ac_dtlkey: 9001, cancelled: false },
        { id: 'a-2', doc_no: 'HC-SO-9', item_code: 'SKU-2', qty: 1, unit_price_centi: 100, linked_ac_dtlkey: 9002, cancelled: false },
        /* Never keyed — this is what forces the question to be asked at all. */
        { id: 'b-1', doc_no: 'HC-SO-10', item_code: 'SKU-3', qty: 1, unit_price_centi: 100, linked_ac_dtlkey: null, cancelled: false },
        { id: 'b-2', doc_no: 'HC-SO-10', item_code: 'SKU-4', qty: 1, unit_price_centi: 100, linked_ac_dtlkey: 9004, cancelled: false },
      ],
      /* Both of SO-9, one of SO-10. b-2 stays behind. */
      delivery_order_items: [
        { id: 'do-item-1', delivery_order_id: 'do-1', so_item_id: 'a-1', item_code: 'SKU-1' },
        { id: 'do-item-2', delivery_order_id: 'do-1', so_item_id: 'a-2', item_code: 'SKU-2' },
        { id: 'do-item-3', delivery_order_id: 'do-1', so_item_id: 'b-1', item_code: 'SKU-3' },
      ],
    });
    expect(await enqueueConvert(sb as never, {
      companyId: 1,
      op: 'so_to_do',
      from: [
        { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
        { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-10' },
      ],
      to: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
      docType: 'DO',
      docNo: 'HC-DO-1',
      docId: 'do-1',
    })).toBe(true);
    const [row] = outbox(sb);
    expect(row.status).toBe('skipped');
    expect(row.last_error).toContain('cannot name the subset');
    /* And nothing was queued alongside the refusal — the failure this pins is a
       PENDING row with no DtlKeys, which is the blind whole-document transfer. */
    expect(outbox(sb).filter((r) => r.status === 'pending')).toHaveLength(0);
  });

  test('a merge that takes EVERY line of every parent still sends the keys it named', async () => {
    const sb = withFlag('1', {
      mfg_sales_order_items: [
        { id: 'a-1', doc_no: 'HC-SO-9', item_code: 'SKU-1', qty: 1, unit_price_centi: 100, linked_ac_dtlkey: 9001, cancelled: false },
        { id: 'b-1', doc_no: 'HC-SO-10', item_code: 'SKU-3', qty: 1, unit_price_centi: 100, linked_ac_dtlkey: 9003, cancelled: false },
      ],
      delivery_order_items: [
        { id: 'do-item-1', delivery_order_id: 'do-1', so_item_id: 'a-1', item_code: 'SKU-1' },
        { id: 'do-item-2', delivery_order_id: 'do-1', so_item_id: 'b-1', item_code: 'SKU-3' },
      ],
    });
    expect(await enqueueConvert(sb as never, {
      companyId: 1,
      op: 'so_to_do',
      from: [
        { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
        { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-10' },
      ],
      to: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
      docType: 'DO',
      docNo: 'HC-DO-1',
      docId: 'do-1',
    })).toBe(true);
    const [row] = outbox(sb);
    expect(row.status).toBe('pending');
    expect(row.payload.body.DtlKeys).toEqual([9001, 9003]);
    expect(row.payload.fromDocs?.map((r: { key: string }) => r.key)).toEqual(['HC-SO-9', 'HC-SO-10']);
  });

  /* ── PARTIAL BY QUANTITY: "3 of 5 on this line" ───────────────────────────
     The one shape DtlKeys alone cannot express. AddPartialTransferDetail moves
     each NAMED line's whole outstanding quantity, so a delivery of 2 out of 5
     booked 5 in a licensed account book and answered ok — silently, because
     nothing on either side disagreed. `Details[].Qty` is how the service was
     taught to hear it, and it is all-or-nothing per document. */
  test('a DO shipping 2 of a 5-unit line names the QUANTITY, not just the line', async () => {
    const sb = withFlag('1', {
      mfg_sales_order_items: [
        { id: 'so-1', doc_no: 'HC-SO-9', item_code: 'SKU-1', qty: 5, unit_price_centi: 100, linked_ac_dtlkey: 9001, cancelled: false },
      ],
      delivery_order_items: [
        { id: 'do-item-1', delivery_order_id: 'do-1', so_item_id: 'so-1', item_code: 'SKU-1', qty: 2 },
      ],
    });
    expect(await enqueueConvert(sb as never, {
      companyId: 1,
      op: 'so_to_do',
      from: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
      to: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
      docType: 'DO', docNo: 'HC-DO-1', docId: 'do-1',
    })).toBe(true);
    const [row] = outbox(sb);
    expect(row.status).toBe('pending');
    expect(row.payload.body.DtlKeys).toEqual([9001]);
    expect(row.payload.body.Details).toEqual([{ DtlKey: 9001, Qty: 2 }]);
  });

  test('a DO shipping the WHOLE line sends no quantity at all', async () => {
    /* Deliberate, and the reason is the failure mode on the other side: a
       quantity routes the service onto the documented PartialTransfer
       overloads and it REFUSES to fall back from them. The plain shape is the
       one proven against this book on every conversion type, and 46,308 of the
       46,318 lines that ever moved were whole. */
    const sb = withFlag('1', {
      mfg_sales_order_items: [
        { id: 'so-1', doc_no: 'HC-SO-9', item_code: 'SKU-1', qty: 5, unit_price_centi: 100, linked_ac_dtlkey: 9001, cancelled: false },
      ],
      delivery_order_items: [
        { id: 'do-item-1', delivery_order_id: 'do-1', so_item_id: 'so-1', item_code: 'SKU-1', qty: 5 },
      ],
    });
    expect(await enqueueConvert(sb as never, {
      companyId: 1,
      op: 'so_to_do',
      from: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
      to: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
      docType: 'DO', docNo: 'HC-DO-1', docId: 'do-1',
    })).toBe(true);
    const [row] = outbox(sb);
    expect(row.payload.body.DtlKeys).toEqual([9001]);
    expect(row.payload.body.Details).toBeUndefined();
  });

  test('one partial line makes EVERY named line carry a quantity', async () => {
    /* PlanTransfer throws on a key named with no Qty while another on the same
       document carries one — "a line with no number would silently move its
       whole outstanding quantity". So the ERP must not send a half-quantified
       document, and this pins that it does not. */
    const sb = withFlag('1', {
      mfg_sales_order_items: [
        { id: 'so-1', doc_no: 'HC-SO-9', item_code: 'SKU-1', qty: 5, unit_price_centi: 100, linked_ac_dtlkey: 9001, cancelled: false },
        { id: 'so-2', doc_no: 'HC-SO-9', item_code: 'SKU-2', qty: 3, unit_price_centi: 100, linked_ac_dtlkey: 9002, cancelled: false },
      ],
      delivery_order_items: [
        { id: 'do-item-1', delivery_order_id: 'do-1', so_item_id: 'so-1', item_code: 'SKU-1', qty: 2 },
        { id: 'do-item-2', delivery_order_id: 'do-1', so_item_id: 'so-2', item_code: 'SKU-2', qty: 3 },
      ],
    });
    expect(await enqueueConvert(sb as never, {
      companyId: 1,
      op: 'so_to_do',
      from: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
      to: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
      docType: 'DO', docNo: 'HC-DO-1', docId: 'do-1',
    })).toBe(true);
    const [row] = outbox(sb);
    expect(row.payload.body.Details).toEqual([
      { DtlKey: 9001, Qty: 2 },
      { DtlKey: 9002, Qty: 3 },
    ]);
    expect(row.payload.body.Details.length).toBe(row.payload.body.DtlKeys.length);
  });

  test('a DO built entirely of ad-hoc lines queues the conversion unchanged', async () => {
    const sb = withFlag('1', {
      mfg_sales_order_items: soLines([9001]),
      delivery_order_items: [
        { id: 'do-item-1', delivery_order_id: 'do-1', so_item_id: null, item_code: 'ADHOC' },
      ],
    });
    expect(await convertDo(sb)).toBe(true);
    const [row] = outbox(sb);
    expect(row.status).toBe('pending');
    expect(row.payload.body.DtlKeys).toBeUndefined();
  });
});
