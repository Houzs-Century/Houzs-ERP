// Re-queueing a document the write-back refused.
//
// The property under test is not "it writes a row" — it is that the verdict
// comes from the REAL composer every time. So these tests never assert on a
// hand-written reason string: they change the DOCUMENT (take the stock location
// away, give it back, set linked_ac_docno) and assert on what the composer then
// does with it.
import { describe, expect, test, beforeEach } from 'vitest';
import { requeueSkipped, REQUEUE_NOTE_PREFIX } from './autocount-requeue';
import { fakeSb, type Row } from './fake-postgrest';
import { resetWritebackFlagCache } from './autocount-writeback-flag';

/* 0277's autocount_outbox_dedupe_idx, declared so the fake enforces it:
   UNIQUE (dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL.
   It is half the idempotency argument — the other half is this module's own
   already-queued check — and a fake that ignored it would let the "twice does
   not double-queue" test pass for the wrong reason. */
const DEDUPE_IDX = [{
  table: 'autocount_outbox',
  column: 'dedupe_key',
  covers: (r: Row) => (r.status ?? 'pending') === 'pending',
  name: 'autocount_outbox_dedupe_idx',
}];

/* A real cutover code, as autocount-outbox.test.ts uses: since D10 the composer
   resolves every ERP code against the 1561-row map and REFUSES what it cannot
   find, so an invented SKU would test the refusal instead of the flow. */
const ERP_A = 'AKEMI APEX MATT (SP)';

const SO_DOC = 'HC-SO-2608-002';

/** The order as it was when it was refused: no line warehouse, no sales_location. */
const soWithoutLocation = () => ({
  doc_no: SO_DOC, so_date: '2026-08-12', debtor_name: 'ACME', agent: 'KRIS',
  sales_location: null, branding: null, venue: null,
  address1: null, address2: null, address3: null, address4: null,
  phone: null, ref: null, po_doc_no: null, internal_expected_dd: null,
  linked_ac_docno: null, company_id: 1,
});

const soItem = () => ({
  doc_no: SO_DOC, item_code: ERP_A, description: 'Mattress', qty: 2,
  unit_price_centi: 12345, cancelled: false, warehouse_id: null,
});

/** The skip the composer's MissingLocationError left behind. */
const skippedRow = (extra: Row = {}) => ({
  id: 'skip-1', company_id: 1, op: 'create_so', doc_type: 'SO', doc_no: SO_DOC,
  doc_id: null, payload: { body: {} }, status: 'skipped', attempts: 0,
  dedupe_key: null,
  last_error: 'refused, nothing sent (MissingLocationError): 2 line(s) carry no stock location',
  created_at: '2026-08-12T02:00:00Z',
  ...extra,
});

const world = (so: Row, outbox: Row[] = [skippedRow()], flag = '1') => fakeSb({
  app_config: [{ key: 'scm.autocount_writeback', value: flag }],
  autocount_outbox: outbox,
  mfg_sales_orders: [so],
  mfg_sales_order_items: [soItem()],
  supplier_material_bindings: [],
}, {}, DEDUPE_IDX);

const rows = (sb: { tables: Record<string, Row[]> }) => sb.tables.autocount_outbox ?? [];
const pending = (sb: { tables: Record<string, Row[]> }) => rows(sb).filter((r) => r.status === 'pending');

beforeEach(() => resetWritebackFlagCache());

describe('a document whose refusal is NOT fixed', () => {
  test('stays refused, and the CURRENT reason is reported', async () => {
    const sb = world(soWithoutLocation());
    const [r] = await requeueSkipped(sb as never, { docNo: SO_DOC, apply: true });
    expect(r.outcome).toBe('still-refused');
    /* Not a string this test invented — the composer's own refusal, reached by
       leaving the order in exactly the state that produced it. */
    expect(r.detail).toContain('MissingLocationError');
    expect(pending(sb)).toHaveLength(0);
  });

  test('APPLY does not append a SECOND skipped row for it', async () => {
    /* The probe already knows the answer, so the real enqueue is never run and
       noteReadFailure never writes. A tool that grew the backlog by one row per
       attempt would make the health report worse the more it was used. */
    const sb = world(soWithoutLocation());
    await requeueSkipped(sb as never, { docNo: SO_DOC, apply: true });
    await requeueSkipped(sb as never, { docNo: SO_DOC, apply: true });
    expect(rows(sb)).toHaveLength(1);
    expect(rows(sb)[0].last_error).not.toContain(REQUEUE_NOTE_PREFIX);
  });

  test('DRY RUN writes nothing at all, not even a note', async () => {
    const sb = world(soWithoutLocation());
    const before = JSON.stringify(rows(sb));
    const [r] = await requeueSkipped(sb as never, { docNo: SO_DOC });
    expect(r.outcome).toBe('still-refused');
    expect(JSON.stringify(rows(sb))).toBe(before);
  });
});

describe('a document whose cause has been FIXED', () => {
  /* The owner set the delivery address, so the order now carries a sales
     location — the exact fix HC-SO-2608-002 got on 2026-08-13. */
  const fixed = () => ({ ...soWithoutLocation(), sales_location: 'KL WAREHOUSE' });

  test('DRY RUN says it would re-queue, and still writes nothing', async () => {
    const sb = world(fixed());
    const [r] = await requeueSkipped(sb as never, { docNo: SO_DOC });
    expect(r.outcome).toBe('would-requeue');
    expect(pending(sb)).toHaveLength(0);
    expect(rows(sb)).toHaveLength(1);
  });

  test('APPLY queues a freshly COMPOSED create, not the old payload', async () => {
    const sb = world(fixed());
    const [r] = await requeueSkipped(sb as never, { docNo: SO_DOC, apply: true });
    expect(r.outcome).toBe('requeued');

    const [queued] = pending(sb);
    expect(queued.op).toBe('create_so');
    expect(queued.dedupe_key).toBe(`create_so:${SO_DOC}`);
    /* Composed from the document AS IT IS NOW: the location the operator just
       set is on the payload. The skipped row's payload was `{}` — there was
       nothing to resurrect even if we had wanted to. */
    expect(queued.payload.body.SalesLocation).toBe('KL');
    expect(queued.payload.body.Details[0].Location).toBe('KL');
    expect(queued.payload.body.Details).toHaveLength(1);
  });

  test('the old skip is annotated so it stops reading as backlog', async () => {
    const sb = world(fixed());
    await requeueSkipped(sb as never, { docNo: SO_DOC, apply: true });
    const old = rows(sb).find((r) => r.id === 'skip-1') as Row;
    expect(old.status).toBe('skipped');
    expect(old.last_error.startsWith(REQUEUE_NOTE_PREFIX)).toBe(true);
    // The original reason survives whole — this table is the audit trail.
    expect(old.last_error).toContain('MissingLocationError');
    expect(old.last_error).toContain('-> outbox');
  });
});

describe('idempotency', () => {
  test('running APPLY twice does not double-queue', async () => {
    const sb = world({ ...soWithoutLocation(), sales_location: 'KL WAREHOUSE' });
    const [first] = await requeueSkipped(sb as never, { docNo: SO_DOC, apply: true });
    const second = await requeueSkipped(sb as never, { docNo: SO_DOC, apply: true });
    expect(first.outcome).toBe('requeued');
    expect(pending(sb)).toHaveLength(1);
    /* Two independent guards, and this asserts the FIRST one fires: the skip is
       annotated, so the second run recognises its own work. */
    expect(second.map((r) => r.outcome)).toEqual(['already-requeued']);
  });

  test('a document already pending is reported, not queued again', async () => {
    /* The second guard, reached by a skip that was never annotated — a create
       queued by some other path while this skip sat there. */
    const sb = world({ ...soWithoutLocation(), sales_location: 'KL WAREHOUSE' }, [
      skippedRow(),
      {
        id: 'row-live', company_id: 1, op: 'create_so', doc_type: 'SO', doc_no: SO_DOC,
        status: 'pending', dedupe_key: `create_so:${SO_DOC}`, payload: { body: {} }, attempts: 0,
      },
    ]);
    const [r] = await requeueSkipped(sb as never, { docNo: SO_DOC, apply: true });
    expect(r.outcome).toBe('already-queued');
    expect(pending(sb)).toHaveLength(1);
  });

  test('the 0277 dedupe index is the backstop under the guards', async () => {
    /* Proving the constraint the idempotency argument leans on, rather than
       asserting it in prose: a skipped row carries dedupe_key NULL, so it never
       collides with a fresh enqueue — and a second PENDING create for the same
       document is refused by Postgres with 23505. */
    const sb = world({ ...soWithoutLocation(), sales_location: 'KL WAREHOUSE' });
    await requeueSkipped(sb as never, { docNo: SO_DOC, apply: true });
    expect((rows(sb).find((r) => r.id === 'skip-1') as Row).dedupe_key).toBeNull();
    const clash = await sb.from('autocount_outbox').insert({
      company_id: 1, op: 'create_so', doc_type: 'SO', doc_no: SO_DOC,
      status: 'pending', dedupe_key: `create_so:${SO_DOC}`, payload: { body: {} },
    });
    expect(clash.error?.code).toBe('23505');
    expect(pending(sb)).toHaveLength(1);
  });
});

describe('what must never be re-queued', () => {
  test('a document already in AutoCount is left alone', async () => {
    const sb = world({
      ...soWithoutLocation(), sales_location: 'KL WAREHOUSE', linked_ac_docno: 'SO-000021',
    });
    const [r] = await requeueSkipped(sb as never, { docNo: SO_DOC, apply: true });
    expect(r.outcome).toBe('already-in-autocount');
    expect(r.detail).toContain('SO-000021');
    expect(pending(sb)).toHaveLength(0);
  });

  test('an EDIT refusal is reported, never re-queued', async () => {
    const sb = world({ ...soWithoutLocation(), linked_ac_docno: 'SO-000021' }, [
      skippedRow({ id: 'skip-edit', op: 'edit', last_error: 'refused, nothing sent (KeylessLineError): line 1' }),
    ]);
    const [r] = await requeueSkipped(sb as never, { docNo: SO_DOC, apply: true });
    expect(r.outcome).toBe('not-recoverable');
    expect(r.detail).toContain('saving the document again');
    expect(pending(sb)).toHaveLength(0);
  });

  test('a parentless conversion is reported, never re-queued', async () => {
    const sb = world(soWithoutLocation(), [
      skippedRow({
        id: 'skip-do', op: 'so_to_do', doc_type: 'DO', doc_no: 'HC-DO-2608-001',
        last_error: 'created with no sales order, so there is no source document to transfer from.',
      }),
    ]);
    const [r] = await requeueSkipped(sb as never, { docType: 'ALL', apply: true });
    expect(r.outcome).toBe('not-recoverable');
    expect(pending(sb)).toHaveLength(0);
  });

  test('nothing is attempted while the write-back switch is off', async () => {
    const sb = world({ ...soWithoutLocation(), sales_location: 'KL WAREHOUSE' }, [skippedRow()], 'off');
    const [r] = await requeueSkipped(sb as never, { docNo: SO_DOC, apply: true });
    /* The enqueue would return false here for a reason that has nothing to do
       with the document, and an operator reading "declined" would go hunting
       for a composer fault that does not exist. */
    expect(r.outcome).toBe('switch-off');
    expect(pending(sb)).toHaveLength(0);
  });

  test('a document that no longer exists is reported, not composed', async () => {
    const sb = fakeSb({
      app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
      autocount_outbox: [skippedRow()],
      mfg_sales_orders: [],
      mfg_sales_order_items: [],
    }, {}, DEDUPE_IDX);
    const [r] = await requeueSkipped(sb as never, { docNo: SO_DOC, apply: true });
    expect(r.outcome).toBe('document-gone');
    expect(pending(sb)).toHaveLength(0);
  });
});

describe('the PO create, which is the other half of what is re-queueable', () => {
  test('a refused create_po is re-composed from the purchase order as it is now', async () => {
    const sb = fakeSb({
      app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
      autocount_outbox: [skippedRow({
        id: 'skip-po', op: 'create_po', doc_type: 'PO', doc_no: 'HC-PO-9', doc_id: 'po-1',
        last_error: 'compose failed, nothing sent: purchase_order_items: 42703',
      })],
      purchase_orders: [{
        id: 'po-1', company_id: 1, po_number: 'HC-PO-9', po_date: '2026-08-12',
        supplier_id: 'sup-1', notes: 'a note', linked_ac_docno: null,
      }],
      suppliers: [{ id: 'sup-1', code: '400-H004', name: 'Supplier' }],
      purchase_order_items: [{
        purchase_order_id: 'po-1', material_code: ERP_A, description: 'D', qty: 3,
        unit_price_centi: 5000, warehouse_id: 'wh-1',
      }],
      warehouses: [{ id: 'wh-1', code: 'KL', name: 'KL WAREHOUSE' }],
      supplier_material_bindings: [],
      /* The four columns scm.purchase_orders has never had. Named so this test
         fails if the composer starts asking for one: PostgREST answers 42703
         and the whole PO flow goes silent. */
    }, { purchase_orders: ['creditor_code', 'creditor_name', 'agent', 'ref'] }, DEDUPE_IDX);

    const [r] = await requeueSkipped(sb as never, { docType: 'PO', apply: true });
    expect(r.outcome).toBe('requeued');
    const [queued] = pending(sb);
    expect(queued.op).toBe('create_po');
    expect(queued.dedupe_key).toBe('create_po:po-1');
    expect(queued.payload.body.CreditorCode).toBe('400-H004');
    expect(queued.payload.body.Details[0].Location).toBe('KL');
  });
});

describe('scope', () => {
  test('by document number', async () => {
    const sb = world({ ...soWithoutLocation(), sales_location: 'KL WAREHOUSE' }, [
      skippedRow(),
      skippedRow({ id: 'skip-2', doc_no: 'HC-SO-2608-001' }),
    ]);
    const out = await requeueSkipped(sb as never, { docNo: SO_DOC });
    expect(out.map((r) => r.docNo)).toEqual([SO_DOC]);
  });

  test('by type — every skipped SO row, each with its own verdict', async () => {
    const sb = world({ ...soWithoutLocation(), sales_location: 'KL WAREHOUSE' }, [
      skippedRow(),
      skippedRow({ id: 'skip-2', doc_no: 'HC-SO-2608-001' }),
      skippedRow({ id: 'skip-po', doc_type: 'PO', op: 'create_po', doc_no: 'HC-PO-9' }),
    ]);
    const out = await requeueSkipped(sb as never, { docType: 'SO' });
    expect(out).toHaveLength(2);
    /* The second names an order the fixture does not hold, so it reports
       document-gone rather than being silently dropped from the report. */
    expect(out.map((r) => r.outcome).sort()).toEqual(['document-gone', 'would-requeue']);
  });
});
