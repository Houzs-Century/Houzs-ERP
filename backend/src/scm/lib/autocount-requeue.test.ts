// Re-queueing a document the write-back refused.
//
// The property under test is not "it writes a row" — it is that the verdict
// comes from the REAL composer every time. So these tests never assert on a
// hand-written reason string: they change the DOCUMENT (take the stock location
// away, give it back, set linked_ac_docno) and assert on what the composer then
// does with it.
import { describe, expect, test, beforeEach } from 'vitest';
import {
  AC_REQUEUE_MEANING,
  acRequeueAccepted,
  requeueOutboxRow,
  requeueSkipped,
  REQUEUE_NOTE_PREFIX,
} from './autocount-requeue';
import { acRowIsRequeueable } from './autocount-outbox-status';
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

/* HC-SO-2608-001 and -002, 2026-08-13: both were re-queued, both then FAILED
   six times on `Foreign Key Error (Constraint Name=FK_SO_SalesAgent)`, and the
   tool could not touch them again — it only ever selected `skipped`. That
   default is right (a failed row was SENT, and the C# create has no duplicate
   guard on the ERP number), so the answer is an explicit opt-in, not a wider
   default. */
describe('a document AutoCount refused is out of scope unless asked for', () => {
  /** The order with the cause fixed, so the composer accepts it. */
  const sendable = () => ({ ...soWithoutLocation(), sales_location: 'KL WAREHOUSE' });
  const failedRow = (extra: Row = {}) => skippedRow({
    id: 'failed-1',
    status: 'failed',
    attempts: 6,
    last_error: 'Gave up after 6 attempts. Last error: Foreign Key Error (Constraint Name=FK_SO_SalesAgent)',
    ...extra,
  });

  test('by default a failed row is not even looked at', async () => {
    const sb = world(sendable(), [failedRow()]);
    const results = await requeueSkipped(sb as never, { apply: true });
    expect(results).toEqual([]);
    expect(pending(sb)).toHaveLength(0);
  });

  test('with includeFailed it is re-composed and queued', async () => {
    const sb = world(sendable(), [failedRow()]);
    const [r] = await requeueSkipped(sb as never, { apply: true, includeFailed: true });
    expect(r.outcome).toBe('requeued');
    expect(pending(sb)).toHaveLength(1);
  });

  test('a dry run with includeFailed still writes nothing', async () => {
    const sb = world(sendable(), [failedRow()]);
    const [r] = await requeueSkipped(sb as never, { includeFailed: true });
    expect(r.outcome).toBe('would-requeue');
    expect(pending(sb)).toHaveLength(0);
  });

  test('a document already SENT is never re-sent, even with includeFailed', async () => {
    /* The case the option must not break: the failure was transient, the retry
       landed, and the book already holds the document. */
    const sb = world(sendable(), [
      failedRow(),
      skippedRow({ id: 'sent-1', status: 'sent', attempts: 1, last_error: null }),
    ]);
    const [r] = await requeueSkipped(sb as never, { apply: true, includeFailed: true });
    expect(r.outcome).toBe('already-queued');
    expect(pending(sb)).toHaveLength(0);
  });

  test('a PENDING row also vetoes — the drain is already going to send it', async () => {
    const sb = world(sendable(), [
      failedRow(),
      skippedRow({ id: 'pending-1', status: 'pending', attempts: 1, last_error: null }),
    ]);
    const [r] = await requeueSkipped(sb as never, { apply: true, includeFailed: true });
    expect(r.outcome).toBe('already-queued');
  });

  test('another FAILED row does not veto — dead history is not a live send', async () => {
    const sb = world(sendable(), [failedRow(), failedRow({ id: 'failed-2' })]);
    const results = await requeueSkipped(sb as never, { apply: true, includeFailed: true });
    expect(results.map((r) => r.outcome)).toEqual(['requeued', 'already-queued']);
    /* The first one queues; the second then sees that live pending row and stands down,
       so one document cannot be queued twice in a single pass. */
    expect(pending(sb)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/** The fake client, typed as the one the module takes. ONE cast for the whole
 *  block rather than `as never` at every call: that pattern is most of this
 *  file's lint ceiling, and a new section must not add to a number that may
 *  only fall. */
const asSb = (sb: unknown) => sb as Parameters<typeof requeueOutboxRow>[0];

// requeueOutboxRow — ONE row, by id, from the AutoCount Sync page's button.
//
// The batch tool above chooses its own rows and can only ever pick a terminal
// one. A button is pointed at whatever the reader is looking at, so this entry
// point has to answer for the two rows the sweep never sees — `sent` and
// `pending` — and for a row id that belongs to the other company's books.
// ─────────────────────────────────────────────────────────────────────────────
describe('requeueOutboxRow — a SENT row is refused outright', () => {
  const sendable = () => ({ ...soWithoutLocation(), sales_location: 'KL WAREHOUSE' });
  const sentRow = (extra: Row = {}) => skippedRow({
    id: 'sent-1',
    status: 'sent',
    attempts: 1,
    last_error: null,
    ac_doc_no: 'SO-000451',
    ...extra,
  });

  test('the code is already-sent and NOTHING is written', async () => {
    /* THE ONE THAT MATTERS. `sent` means AutoCount accepted the document and it
       is in the account book. The C# create has no duplicate guard on the ERP
       document number, so a second send writes a SECOND document into a live
       licensed book — and an accepted sales order cannot simply be deleted
       there. The document below is otherwise perfectly sendable, so nothing but
       the status refusal is standing between this call and that duplicate. */
    const sb = world(sendable(), [sentRow()]);
    const before = JSON.stringify(rows(sb));
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'sent-1', companyId: 1 });
    expect(r.outcome).toBe('already-sent');
    expect(JSON.stringify(rows(sb))).toBe(before);
    expect(pending(sb)).toHaveLength(0);
  });

  test('it refuses BEFORE reading the document, so a missing order cannot change the answer', async () => {
    /* Ordering is the property, not the verdict: if the status check sat after
       the document read, an order that had been deleted would answer
       document-gone and a reader would conclude the send was merely unlucky
       rather than forbidden. */
    const sb = fakeSb({
      app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
      autocount_outbox: [sentRow()],
      mfg_sales_orders: [],
      mfg_sales_order_items: [],
      supplier_material_bindings: [],
    }, {}, DEDUPE_IDX);
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'sent-1', companyId: 1 });
    expect(r.outcome).toBe('already-sent');
  });

  test('the switch being OFF does not change it either — refused is refused', async () => {
    const sb = world(sendable(), [sentRow()], 'off');
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'sent-1', companyId: 1 });
    expect(r.outcome).toBe('already-sent');
  });

  test('the sentence it answers with never says the word "sent" as a status word', async () => {
    /* The owner's rule for this page is that no code jargon appears on it. The
       message must explain the CONSEQUENCE — a second copy in the book — not
       recite the column value. */
    const sb = world(sendable(), [sentRow()]);
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'sent-1', companyId: 1 });
    expect(AC_REQUEUE_MEANING[r.outcome]).toContain('SECOND copy');
    expect(acRequeueAccepted(r.outcome)).toBe(false);
  });
});

describe('requeueOutboxRow — the rest of the by-id ladder', () => {
  const sendable = () => ({ ...soWithoutLocation(), sales_location: 'KL WAREHOUSE' });

  test('a PENDING row is refused: the sweep is already going to send it', async () => {
    const sb = world(sendable(), [skippedRow({ id: 'p-1', status: 'pending', last_error: null })]);
    const before = JSON.stringify(rows(sb));
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'p-1', companyId: 1 });
    expect(r.outcome).toBe('row-pending');
    expect(JSON.stringify(rows(sb))).toBe(before);
  });

  test('ANOTHER COMPANY\'S row is not found, and nothing is written', async () => {
    /* The SCM client is service-role and bypasses RLS, so the company predicate
       on the read IS the tenant boundary. Answering "not found" rather than
       "not yours" is deliberate: confirming that somebody else's id exists is
       itself a leak. */
    const sb = world(sendable(), [skippedRow({ id: 'other-1', company_id: 2 })]);
    const before = JSON.stringify(rows(sb));
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'other-1', companyId: 1 });
    expect(r.outcome).toBe('row-not-found');
    expect(JSON.stringify(rows(sb))).toBe(before);
  });

  test('the SAME row in the caller\'s own company DOES go through', async () => {
    /* The paired positive half: a scope assertion that only ever checks the
       negative passes just as happily when the endpoint does nothing at all. */
    const sb = world(sendable(), [skippedRow({ id: 'other-1', company_id: 1 })]);
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'other-1', companyId: 1 });
    expect(r.outcome).toBe('requeued');
    expect(pending(sb)).toHaveLength(1);
  });

  test('an unknown id is not found', async () => {
    const sb = world(sendable());
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'no-such-row', companyId: 1 });
    expect(r.outcome).toBe('row-not-found');
  });

  test('a SKIPPED row whose cause is fixed is queued, and the old skip is annotated', async () => {
    const sb = world(sendable());
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'skip-1', companyId: 1 });
    expect(r.outcome).toBe('requeued');
    expect(acRequeueAccepted(r.outcome)).toBe(true);
    expect(r.newRowId).toBe(pending(sb)[0].id);
    expect(rows(sb).find((x) => x.id === 'skip-1')?.last_error)
      .toContain(REQUEUE_NOTE_PREFIX);
  });

  test('a SKIPPED row whose cause is NOT fixed reports the CURRENT blocker', async () => {
    const sb = world(soWithoutLocation());
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'skip-1', companyId: 1 });
    expect(r.outcome).toBe('still-refused');
    expect(r.detail).toContain('MissingLocationError');
    expect(pending(sb)).toHaveLength(0);
  });

  test('the button needs no includeFailed opt-in — a FAILED row is exactly what it is for', async () => {
    /* The workflow hides `failed` behind a flag because it sweeps a whole
       backlog blind. A person pressing a button on one row has already read
       that row's reason, so the opt-in has nothing left to protect. What DOES
       still protect them is the sent check above, which the flag never could. */
    const sb = world(sendable(), [skippedRow({
      id: 'f-1',
      status: 'failed',
      attempts: 6,
      last_error: 'Gave up after 6 attempts. Last error: Foreign Key Error (Constraint Name=FK_SO_SalesAgent)',
    })]);
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'f-1', companyId: 1 });
    expect(r.outcome).toBe('requeued');
    expect(pending(sb)).toHaveLength(1);
  });

  test('the re-queued row starts its attempts again — a failed row has spent all six', async () => {
    /* MAX_ATTEMPTS is 6 and the drain selects `.lt('attempts', MAX_ATTEMPTS)`,
       so a re-queue that re-opened the dead row would produce a pending row no
       sweep can ever pick up: queued, visibly waiting, and dead. The reset is
       structural — the enqueue INSERTS a new row and sets no `attempts` at all,
       leaving 0277's `attempts integer NOT NULL DEFAULT 0` to supply zero. This
       asserts the property that matters (the new row has not inherited six),
       not the mechanism. */
    const sb = world(sendable(), [skippedRow({ id: 'f-1', status: 'failed', attempts: 6 })]);
    await requeueOutboxRow(asSb(sb), { rowId: 'f-1', companyId: 1 });
    const [queued] = pending(sb);
    expect(queued.attempts ?? 0).toBe(0);
    expect(rows(sb).find((x) => x.id === 'f-1')?.attempts).toBe(6);
  });

  test('pressing it TWICE does not queue the document twice', async () => {
    const sb = world(sendable());
    const first = await requeueOutboxRow(asSb(sb), { rowId: 'skip-1', companyId: 1 });
    const second = await requeueOutboxRow(asSb(sb), { rowId: 'skip-1', companyId: 1 });
    expect(first.outcome).toBe('requeued');
    /* The old skip now carries the marker, so the ladder recognises its own
       work rather than composing a second create. */
    expect(second.outcome).toBe('already-requeued');
    expect(pending(sb)).toHaveLength(1);
  });

  test('an edit or a conversion is refused as not-recoverable, not silently ignored', async () => {
    const sb = world(sendable(), [skippedRow({ id: 'e-1', op: 'edit' })]);
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'e-1', companyId: 1 });
    expect(r.outcome).toBe('not-recoverable');
    expect(pending(sb)).toHaveLength(0);
  });

  test('the switch being OFF is named as such, not reported as a composer problem', async () => {
    const sb = world(sendable(), [skippedRow()], 'off');
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'skip-1', companyId: 1 });
    expect(r.outcome).toBe('switch-off');
    expect(pending(sb)).toHaveLength(0);
  });
});

describe('the outcome vocabulary is complete and matches its catalogue', () => {
  test('every outcome the ladder can return has a plain-English sentence', () => {
    /* A missing entry renders on the owner's page as `undefined`, which is the
       one thing this whole return shape exists to prevent. The Record type
       makes the compiler enforce it; this asserts the sentences are real. */
    for (const [code, sentence] of Object.entries(AC_REQUEUE_MEANING)) {
      expect(sentence.length, `${code} has no sentence`).toBeGreaterThan(20);
      /* No jargon on the owner's page: no snake_case column names, no error
         class names, no hyphenated status keys leaking through. */
      expect(sentence, `${code} leaks a code identifier`).not.toMatch(/[a-z]+_[a-z]+/);
      expect(sentence, `${code} names an exception class`).not.toMatch(/[A-Za-z]+Error\b/);
    }
  });

  /* The catalogue file itself is pinned against these keys by
     backend/tests/autocountSyncReasonsCatalogue.test.ts — it lives there because
     reading a file needs node:fs, which backend/tsconfig.json deliberately does
     not type for src/ (its `types` is workers-types only). */

  test('acRowIsRequeueable never offers a button on a row the ladder refuses structurally', () => {
    /* The pure hint and the real gate are two files, so they are pinned
       together: wherever the button would appear, the ladder must not answer
       with one of its four permanent noes. */
    const marker = `${REQUEUE_NOTE_PREFIX} 2026-08-16T00:00:00.000Z -> outbox x] refused, nothing sent (ItemCodeError): y`;
    expect(acRowIsRequeueable('create_so', 'sent', null)).toBe(false);
    expect(acRowIsRequeueable('create_so', 'pending', null)).toBe(false);
    expect(acRowIsRequeueable('create_so', 'skipped', marker)).toBe(false);
    expect(acRowIsRequeueable('edit', 'skipped', 'refused, nothing sent (KeylessLineError): x')).toBe(false);
    expect(acRowIsRequeueable('so_to_do', 'skipped', 'no source document to transfer from')).toBe(false);
    /* And the two it MUST offer, or the button never appears at all. */
    expect(acRowIsRequeueable('create_so', 'skipped', 'refused, nothing sent (ItemCodeError): x')).toBe(true);
    expect(acRowIsRequeueable('create_po', 'failed', 'Foreign Key Error (Constraint Name=FK_PO_Creditor)')).toBe(true);
  });
});
