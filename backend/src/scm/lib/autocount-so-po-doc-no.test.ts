// The sales order's "PO Doc No." names the purchase orders made from it, in the
// office plug-in's ", " form (docs/bugs/0926).
import { describe, expect, test, vi } from 'vitest';
import {
  AC_PO_DOC_NO_MAX,
  composeSoPoDocNoEdit,
  joinPoDocNos,
  queueSoPoDocNos,
  readSoPoDocNos,
  type PoDocNoEnqueue,
} from './autocount-so-po-doc-no';
import { fakeSb, type Row } from './fake-postgrest';

const asSb = (sb: unknown) => sb as Parameters<typeof readSoPoDocNos>[0];

/* HC-SO-012411 was made into two purchase orders: one carried over from the book
   (PO-009995) and one the ERP made (HC-PO-2609-122). A third was cancelled, and a
   fourth has not reached the book yet. */
const world = (extra: Record<string, Row[]> = {}) => fakeSb({
  mfg_sales_orders: [{ doc_no: 'HC-SO-012411', company_id: 1, status: 'CONFIRMED', linked_ac_docno: 'SO-012411' }],
  mfg_sales_order_items: [
    { id: 'si-1', doc_no: 'HC-SO-012411', company_id: 1 },
    { id: 'si-2', doc_no: 'HC-SO-012411', company_id: 1 },
  ],
  purchase_order_items: [
    { id: 'pl-1', purchase_order_id: 'po-new', so_item_id: 'si-1' },
    { id: 'pl-2', purchase_order_id: 'po-old', so_item_id: 'si-2' },
    { id: 'pl-3', purchase_order_id: 'po-cancelled', so_item_id: 'si-2' },
    { id: 'pl-4', purchase_order_id: 'po-unsent', so_item_id: 'si-1' },
  ],
  purchase_orders: [
    { id: 'po-new', company_id: 1, po_number: 'HC-PO-2609-122', status: 'SUBMITTED', linked_ac_docno: 'HC-PO-2609-122' },
    { id: 'po-old', company_id: 1, po_number: 'HC-PO-009995', status: 'RECEIVED', linked_ac_docno: 'PO-009995' },
    { id: 'po-cancelled', company_id: 1, po_number: 'HC-PO-2609-130', status: 'CANCELLED', linked_ac_docno: 'HC-PO-2609-130' },
    { id: 'po-unsent', company_id: 1, po_number: 'HC-PO-2609-131', status: 'SUBMITTED', linked_ac_docno: null },
  ],
  ...extra,
});

const sent = (over: Partial<{ op: string; doc_type: string; doc_no: string; doc_id: string | null }> = {}) => ({
  company_id: 1, op: 'create_po', doc_type: 'PO', doc_no: 'HC-PO-2609-122', doc_id: 'po-new', ...over,
});

describe('joinPoDocNos', () => {
  test('sorted, de-duplicated and joined with ", ", as the plug-in writes several', () => {
    expect(joinPoDocNos(['PO-009995', 'HC-PO-2609-122', 'PO-009995', null, ' '])).toBe('HC-PO-2609-122, PO-009995');
    expect(joinPoDocNos([])).toBe('');
  });

  test('whole numbers only, stopping before the field would overflow', () => {
    const many = Array.from({ length: 60 }, (_, i) => `HC-PO-2609-${String(i).padStart(3, '0')}`);
    const out = joinPoDocNos(many);
    expect(out.length).toBeLessThanOrEqual(AC_PO_DOC_NO_MAX);
    expect(out.split(', ').every((n) => /^HC-PO-2609-\d{3}$/.test(n))).toBe(true);
  });
});

describe('readSoPoDocNos', () => {
  test('the live purchase orders the book holds, and neither a cancelled nor an unsent one', async () => {
    expect((await readSoPoDocNos(asSb(world()), 1, 'HC-SO-012411')).sort()).toEqual(['HC-PO-2609-122', 'PO-009995']);
  });
});

describe('queueSoPoDocNos, after a purchase order reaches the book', () => {
  test('a create queues the source order a header-only edit naming its purchase orders', async () => {
    const enqueue = vi.fn<PoDocNoEnqueue>(async () => true);
    expect(await queueSoPoDocNos(asSb(world()), sent(), enqueue)).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const input = enqueue.mock.calls[0][0];
    expect(input).toMatchObject({ companyId: 1, op: 'edit', docType: 'SO', docNo: 'HC-SO-012411', dedupeKey: null });
    expect(input.payload.body).toEqual(composeSoPoDocNoEdit('SO-012411', 'HC-PO-2609-122, PO-009995'));
    expect(input.payload.body).toEqual({ DocType: 'SO', DocNo: 'SO-012411', Header: { UDF: { ToPONo: 'HC-PO-2609-122, PO-009995' } }, Lines: [] });
  });

  test('a cancel that leaves no purchase order clears the field the ERP filled', async () => {
    const sb = world({
      purchase_order_items: [{ id: 'pl-1', purchase_order_id: 'po-new', so_item_id: 'si-1' }],
      purchase_orders: [{ id: 'po-new', company_id: 1, po_number: 'HC-PO-2609-122', status: 'CANCELLED', linked_ac_docno: 'HC-PO-2609-122' }],
    });
    const enqueue = vi.fn<PoDocNoEnqueue>(async () => true);
    expect(await queueSoPoDocNos(asSb(sb), sent({ op: 'cancel' }), enqueue)).toBe(1);
    expect((enqueue.mock.calls[0][0].payload.body as { Header: { UDF: { ToPONo: string } } }).Header.UDF.ToPONo).toBe('');
  });

  test('CONTROL: an order the book does not hold yet, a receipt, or a purchase for stock queues nothing', async () => {
    const enqueue = vi.fn<PoDocNoEnqueue>(async () => true);
    const notInBook = world({ mfg_sales_orders: [{ doc_no: 'HC-SO-012411', company_id: 1, status: 'CONFIRMED', linked_ac_docno: null }] });
    expect(await queueSoPoDocNos(asSb(notInBook), sent(), enqueue)).toBe(0);
    expect(await queueSoPoDocNos(asSb(world()), sent({ op: 'po_to_gr', doc_type: 'GR' }), enqueue)).toBe(0);
    const stock = world({ purchase_order_items: [{ id: 'pl-9', purchase_order_id: 'po-new', so_item_id: null }] });
    expect(await queueSoPoDocNos(asSb(stock), sent(), enqueue)).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('another company\'s order behind the same line id is not touched', async () => {
    const sb = world({
      mfg_sales_order_items: [{ id: 'si-1', doc_no: 'HC-SO-012411', company_id: 2 }],
    });
    const enqueue = vi.fn<PoDocNoEnqueue>(async () => true);
    expect(await queueSoPoDocNos(asSb(sb), sent(), enqueue)).toBe(0);
  });
});

describe('through the drain', () => {
  test('a purchase order create marked sent queues its source order the PO Doc No. edit', async () => {
    const { dispatchOne } = await import('./autocount-outbox');
    const { resetWritebackFlagCache } = await import('./autocount-writeback-flag');
    resetWritebackFlagCache();
    const sb = world({
      app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
      autocount_outbox: [{ id: 'ob-po', company_id: 1, op: 'create_po', doc_type: 'PO', doc_no: 'HC-PO-2609-122', doc_id: 'po-new', status: 'pending', attempts: 0, created_at: '2026-09-15T09:00:00Z' }],
    });
    sb.tables.purchase_orders[0].linked_ac_docno = null;
    const host = vi.fn(async () => new Response(JSON.stringify({ ok: true, docNo: 'HC-PO-2609-122' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const row = {
      id: 'ob-po', company_id: 1, op: 'create_po', doc_type: 'PO', doc_no: 'HC-PO-2609-122', doc_id: 'po-new', status: 'pending', attempts: 0, dedupe_key: null,
      payload: { body: { DocNo: 'HC-PO-2609-122' }, writeback: { table: 'purchase_orders', keyCol: 'id', key: 'po-new' } },
    } as unknown as Parameters<typeof dispatchOne>[2];
    const env = { AC_SYNC_URL: 'http://ac.local:8900', AC_SYNC_KEY: 'k' } as unknown as Parameters<typeof dispatchOne>[0];

    expect(await dispatchOne(env, sb as unknown as Parameters<typeof dispatchOne>[1], row, host as unknown as typeof fetch)).toBe('sent');
    const queued = sb.tables.autocount_outbox.filter((r) => r.doc_type === 'SO');
    expect(queued, 'the source order was not queued').toHaveLength(1);
    expect((queued[0].payload as { body: unknown }).body).toEqual({ DocType: 'SO', DocNo: 'SO-012411', Header: { UDF: { ToPONo: 'HC-PO-2609-122, PO-009995' } }, Lines: [] });
  });
});
