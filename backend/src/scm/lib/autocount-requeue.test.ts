import { describe, expect, test, beforeEach } from 'vitest';
import {
  AC_REQUEUE_MEANING,
  acRequeueAccepted,
  requeueOneRow,
  requeueOutboxRow,
  requeueSkipped,
  REQUEUE_NOTE_PREFIX,
} from './autocount-requeue';
import { acRowIsRequeueable } from './autocount-outbox-status';
import { fakeSb, type Row } from './fake-postgrest';
import { resetWritebackFlagCache } from './autocount-writeback-flag';

const DEDUPE_IDX = [{
  table: 'autocount_outbox',
  column: 'dedupe_key',
  covers: (r: Row) => (r.status ?? 'pending') === 'pending',
  name: 'autocount_outbox_dedupe_idx',
}];

const ERP_A = 'AKEMI APEX MATT (SP)';

const SO_DOC = 'HC-SO-2608-002';

const soWithoutLocation = () => ({
  doc_no: SO_DOC, so_date: '2026-08-12', debtor_name: 'ACME', agent: 'KRIS',
  sales_location: null, branding: null, venue: null,
  address1: null, address2: null, address3: null, address4: null,
  phone: null, ref: null, po_doc_no: null, internal_expected_dd: null,
  linked_ac_docno: null, company_id: 1,
});

const soItem = () => ({
  doc_no: SO_DOC, item_code: ERP_A, description: 'Mattress', qty: 2,
  unit_price_sen: 12345, cancelled: false, warehouse_id: null,
});

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
    expect(r.detail).toContain('MissingLocationError');
    expect(pending(sb)).toHaveLength(0);
  });

  test('APPLY does not append a SECOND skipped row for it', async () => {
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
    expect(second.map((r) => r.outcome)).toEqual(['already-requeued']);
  });

  test('a document already pending is reported, not queued again', async () => {
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

  /* CHANGED 2026-09-02, docs/bugs/0614. This asserted that an edit refusal is
     never re-queued, and the reason it gave was sound: a skipped edit's payload
     is `{}`, so the RETIREMENTS the original save carried are unrecoverable and
     a re-composed keyed edit would leave those lines live in the account book.
     A REBUILD needs none of that list - it clears the details and lays the ERP's
     lines down - so the one hazard the refusal existed for cannot occur. */
  test('an EDIT refusal is re-queued as a REBUILD, never as a keyed edit', async () => {
    const sb = world({ ...soWithoutLocation(), linked_ac_docno: 'SO-000021' }, [
      skippedRow({ id: 'skip-edit', op: 'edit', last_error: 'refused, nothing sent (KeylessLineError): line 1' }),
    ]);
    const [r] = await requeueSkipped(sb as never, { docNo: SO_DOC, apply: true });
    expect(r.outcome).toBe('requeued');
    expect(r.detail).toContain('REBUILD');
    expect(pending(sb)).toHaveLength(1);
    expect((pending(sb)[0].payload as { body: Record<string, unknown> }).body.Rebuild).toBe(true);
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
        purchase_order_id: 'po-1', item_code: ERP_A, description: 'D', qty: 3,
        unit_price_sen: 5000, warehouse_id: 'wh-1',
      }],
      warehouses: [{ id: 'wh-1', code: 'KL', name: 'KL WAREHOUSE' }],
      supplier_material_bindings: [],
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
    expect(out.map((r) => r.outcome).sort()).toEqual(['document-gone', 'would-requeue']);
  });
});

describe('a document AutoCount refused is out of scope unless asked for', () => {
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
    expect(pending(sb)).toHaveLength(1);
  });
});

const asSb = (sb: unknown) => sb as Parameters<typeof requeueOutboxRow>[0];
const asRow = (row: Row) => row as Parameters<typeof requeueOneRow>[1];

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
    const sb = world(sendable(), [sentRow()]);
    const before = JSON.stringify(rows(sb));
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'sent-1', companyId: 1 });
    expect(r.outcome).toBe('already-sent');
    expect(JSON.stringify(rows(sb))).toBe(before);
    expect(pending(sb)).toHaveLength(0);
  });

  test('it refuses BEFORE reading the document, so a missing order cannot change the answer', async () => {
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
    const sb = world(sendable(), [skippedRow({ id: 'other-1', company_id: 2 })]);
    const before = JSON.stringify(rows(sb));
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'other-1', companyId: 1 });
    expect(r.outcome).toBe('row-not-found');
    expect(JSON.stringify(rows(sb))).toBe(before);
  });

  test('the SAME row in the caller\'s own company DOES go through', async () => {
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
    expect(second.outcome).toBe('already-requeued');
    expect(pending(sb)).toHaveLength(1);
  });

  /* The edit row is a DELIVERY ORDER's on purpose: since docs/bugs/0614 a sales
     order's edit IS re-queueable (as a rebuild), and a document built by
     conversion is the half that stays refused - its lines are where AutoCount
     records what it came from (docs/bugs/0611). */
  test('an edit on a converted document is refused as not-recoverable, not silently ignored', async () => {
    const sb = world(sendable(), [skippedRow({ id: 'e-1', op: 'edit', doc_type: 'DO', doc_id: 'do-1' })]);
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
    for (const [code, sentence] of Object.entries(AC_REQUEUE_MEANING)) {
      expect(sentence.length, `${code} has no sentence`).toBeGreaterThan(20);
      expect(sentence, `${code} leaks a code identifier`).not.toMatch(/[a-z]+_[a-z]+/);
      expect(sentence, `${code} names an exception class`).not.toMatch(/[A-Za-z]+Error\b/);
    }
  });


  test('acRowIsRequeueable never offers a button on a row the ladder refuses structurally', () => {
    const marker = `${REQUEUE_NOTE_PREFIX} 2026-08-16T00:00:00.000Z -> outbox x] refused, nothing sent (ItemCodeError): y`;
    expect(acRowIsRequeueable('create_so', 'sent', null)).toBe(false);
    expect(acRowIsRequeueable('create_so', 'pending', null)).toBe(false);
    expect(acRowIsRequeueable('create_so', 'skipped', marker)).toBe(false);
    /* FLIPPED 2026-09-02, docs/bugs/0614: a held-back edit is re-sendable, as a
       REBUILD. The hint is op-shaped and knows no document type, so it also
       offers the button on a DELIVERY ORDER's edit, which the ladder then
       refuses in words - the same trade this file already made for conversions
       five lines down, and for the same reason: a refusal that explains itself
       beats a control that is simply absent. The three noes below are about the
       ROW, and re-reading the document cannot make a sent row unsent. */
    expect(acRowIsRequeueable('edit', 'skipped', 'refused, nothing sent (KeylessLineError): x')).toBe(true);
    expect(acRowIsRequeueable('edit', 'sent', null)).toBe(false);
    expect(acRowIsRequeueable('edit', 'skipped', marker)).toBe(false);
    /* A skipped CONVERSION is no longer on this list. Owner 2026-08-24:
       「我的 GR PO 所有文件都要有 Send Now 的 button」— the button is offered and
       the SEND re-resolves the parent (parentedAfterAll), because "there is no
       earlier document" was a false claim on eight production documents. The
       three structural noes above are unchanged: they are about the ROW, and
       re-reading the document cannot make a sent row unsent. */
    expect(acRowIsRequeueable('so_to_do', 'skipped', 'no source document to transfer from')).toBe(true);
    expect(acRowIsRequeueable('create_so', 'skipped', 'refused, nothing sent (ItemCodeError): x')).toBe(true);
    expect(acRowIsRequeueable('create_po', 'failed', 'Foreign Key Error (Constraint Name=FK_PO_Creditor)')).toBe(true);
  });

  test('every conversion gets a button, refused or held back alike', () => {
    /* THE RULE CHANGED, AND THIS IS THE RULE. Owner 2026-08-24: 「我的 GR PO
       所有文件都要有 Send Now 的 button」and 「不是摆设品」.

       It used to read "`failed` is the service's answer and is offered;
       `skipped` is the document's own shape and never is". The second half was
       answering the wrong question. `skipped` is what the CREATE PATH concluded
       about the document, and for the commonest skip — "no source document to
       transfer from" — the create path was simply not looking at the lines
       (docs/bugs/0524). Withholding the button made that mistake permanent and
       invisible. Now the button is offered and the send re-asks the question;
       a document that really has no parent gets the refusal, in a sentence,
       which is more than a greyed-out row ever told anyone. */
    expect(acRowIsRequeueable('so_to_do', 'failed', 'Invalid transfer item.')).toBe(true);
    expect(acRowIsRequeueable('po_to_gr', 'failed', 'AutoCount login failed')).toBe(true);
    expect(acRowIsRequeueable('do_to_iv', 'failed', 'Gave up after 6 attempts. Last error: fetch failed')).toBe(true);
    expect(acRowIsRequeueable('gr_to_pi', 'failed', 'Invalid transfer item.')).toBe(true);
    expect(acRowIsRequeueable('so_to_po', 'failed', 'Invalid transfer item.')).toBe(true);
    for (const reason of [
      'created with no sales order, so there is no source document to transfer from.',
      'AutoCount transfers from ONE source document',
      'this SO -> DO transfers only 2 of the source document\'s lines, and 1 of them carry no AutoCount DtlKey',
    ]) {
      expect(acRowIsRequeueable('so_to_do', 'skipped', reason), reason).toBe(true);
    }
    expect(acRowIsRequeueable('so_to_do', 'failed',
      `${REQUEUE_NOTE_PREFIX} 2026-08-16T00:00:00.000Z -> outbox x] Invalid transfer item.`)).toBe(false);
    expect(acRowIsRequeueable('so_to_do', 'sent', null)).toBe(false);
    expect(acRowIsRequeueable('so_to_do', 'pending', null)).toBe(false);
  });
});

describe('a conversion the SERVICE refused', () => {
  const doPayload = () => ({
    body: { DocNo: 'HC-DO-2608-002', DtlKeys: [905348, 905349] },
    fromDoc: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-2608-002' },
    writeback: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
    lineWriteback: { table: 'delivery_order_items', ids: ['di-1', 'di-2'], codes: [ERP_A, ERP_A] },
  });

  const failedConversion = (extra: Row = {}) => ({
    id: 'conv-1', company_id: 1, op: 'so_to_do', doc_type: 'DO', doc_no: 'HC-DO-2608-002',
    doc_id: 'do-1', payload: doPayload(), status: 'failed', attempts: 6,
    dedupe_key: 'so_to_do:do-1',
    last_error: 'Invalid transfer item.',
    created_at: '2026-08-16T02:00:00Z',
    ...extra,
  });

  const skippedConversion = (reason: string, extra: Row = {}) => ({
    id: 'conv-skip', company_id: 1, op: 'so_to_do', doc_type: 'DO', doc_no: 'HC-DO-2608-009',
    doc_id: 'do-9', payload: { body: {} }, status: 'skipped', attempts: 0, dedupe_key: null,
    last_error: reason,
    created_at: '2026-08-16T02:00:00Z',
    ...extra,
  });

  const convWorld = (outbox: Row[], deliveryOrders: Row[] = [{ id: 'do-1', linked_ac_docno: null }]) => fakeSb({
    app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
    autocount_outbox: outbox,
    delivery_orders: deliveryOrders,
    mfg_sales_orders: [soWithoutLocation()],
    mfg_sales_order_items: [soItem()],
    supplier_material_bindings: [],
  }, {}, DEDUPE_IDX);

  test('is queued again with the RECORDED instruction, byte for byte', async () => {
    const sb = convWorld([failedConversion()]);
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'conv-1', companyId: 1 });
    expect(r.outcome).toBe('requeued-as-recorded');
    expect(acRequeueAccepted(r.outcome)).toBe(true);

    const [queued] = pending(sb);
    expect(queued.op).toBe('so_to_do');
    expect(queued.doc_no).toBe('HC-DO-2608-002');
    expect(queued.payload).toEqual(doPayload());
    expect(queued.dedupe_key).toBe('so_to_do:do-1');
    expect(queued.attempts ?? 0).toBe(0);
    expect(rows(sb).find((x) => x.id === 'conv-1')?.attempts).toBe(6);
  });

  test('a so_to_po keeps the key enqueuePoCreate gave it, which is NOT its own op name', async () => {
    const sb = fakeSb({
      app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
      autocount_outbox: [{
        id: 'xfer-po', company_id: 1, op: 'so_to_po', doc_type: 'PO', doc_no: 'HC-PO-9',
        doc_id: 'po-1', status: 'failed', attempts: 6,
        dedupe_key: 'create_po:po-1',
        last_error: 'Invalid transfer item.',
        payload: {
          body: { DocNo: 'HC-PO-9', DtlKeys: [905348] },
          fromDoc: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: SO_DOC },
          writeback: { table: 'purchase_orders', keyCol: 'id', key: 'po-1' },
        },
        created_at: '2026-08-16T02:00:00Z',
      }],
      purchase_orders: [{ id: 'po-1', linked_ac_docno: null }],
    }, {}, DEDUPE_IDX);

    const r = await requeueOutboxRow(asSb(sb), { rowId: 'xfer-po', companyId: 1 });
    expect(r.outcome).toBe('requeued-as-recorded');
    expect(pending(sb)[0].dedupe_key).toBe('create_po:po-1');

    const clash = await sb.from('autocount_outbox').insert({
      company_id: 1, op: 'create_po', doc_type: 'PO', doc_no: 'HC-PO-9',
      status: 'pending', dedupe_key: 'create_po:po-1', payload: { body: {} },
    });
    expect(clash.error?.code).toBe('23505');
  });

  test('the old row is annotated so it stops reading as backlog', async () => {
    const sb = convWorld([failedConversion()]);
    await requeueOutboxRow(asSb(sb), { rowId: 'conv-1', companyId: 1 });
    const old = rows(sb).find((x) => x.id === 'conv-1') as Row;
    expect(old.status).toBe('failed');
    expect(old.last_error.startsWith(REQUEUE_NOTE_PREFIX)).toBe(true);
    expect(old.last_error).toContain('Invalid transfer item.');
  });

  test('the batch sweep reaches it too, and only behind includeFailed', async () => {
    const sb = convWorld([failedConversion()]);
    expect(await requeueSkipped(asSb(sb), { docNo: 'HC-DO-2608-002', apply: true })).toEqual([]);
    const [r] = await requeueSkipped(asSb(sb), {
      docNo: 'HC-DO-2608-002', apply: true, includeFailed: true,
    });
    expect(r.outcome).toBe('requeued-as-recorded');
    expect(pending(sb)).toHaveLength(1);
  });

  test('a DRY RUN says it would, and writes nothing', async () => {
    const sb = convWorld([failedConversion()]);
    const before = JSON.stringify(rows(sb));
    const [r] = await requeueSkipped(asSb(sb), { docNo: 'HC-DO-2608-002', includeFailed: true });
    expect(r.outcome).toBe('would-requeue');
    expect(JSON.stringify(rows(sb))).toBe(before);
  });

  test('pressing it twice does not queue the transfer twice', async () => {
    const sb = convWorld([failedConversion()]);
    const first = await requeueOutboxRow(asSb(sb), { rowId: 'conv-1', companyId: 1 });
    const second = await requeueOutboxRow(asSb(sb), { rowId: 'conv-1', companyId: 1 });
    expect(first.outcome).toBe('requeued-as-recorded');
    expect(second.outcome).toBe('already-requeued');
    expect(pending(sb)).toHaveLength(1);
  });

  test('a document the account book already holds is refused', async () => {
    const sb = convWorld([failedConversion()], [{ id: 'do-1', linked_ac_docno: 'DO-000112' }]);
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'conv-1', companyId: 1 });
    expect(r.outcome).toBe('already-in-autocount');
    expect(r.detail).toContain('DO-000112');
    expect(pending(sb)).toHaveLength(0);
  });

  test('a live row for the same transfer vetoes it', async () => {
    const sb = convWorld([
      failedConversion(),
      failedConversion({ id: 'conv-live', status: 'pending', attempts: 0, last_error: null }),
    ]);
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'conv-1', companyId: 1 });
    expect(r.outcome).toBe('already-queued');
  });

  test('a deleted delivery order is reported, not sent', async () => {
    const sb = convWorld([failedConversion()], []);
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'conv-1', companyId: 1 });
    expect(r.outcome).toBe('document-gone');
    expect(pending(sb)).toHaveLength(0);
  });

  test('an empty payload is refused even though the row says failed', async () => {
    const sb = convWorld([failedConversion({ payload: { body: {} } })]);
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'conv-1', companyId: 1 });
    expect(r.outcome).toBe('not-recoverable');
    expect(r.detail).toContain('no composed document');
    expect(pending(sb)).toHaveLength(0);
  });

  test('the switch being OFF stops it, like every other re-send', async () => {
    const sb = fakeSb({
      app_config: [{ key: 'scm.autocount_writeback', value: 'off' }],
      autocount_outbox: [failedConversion()],
      delivery_orders: [{ id: 'do-1', linked_ac_docno: null }],
    }, {}, DEDUPE_IDX);
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'conv-1', companyId: 1 });
    expect(r.outcome).toBe('switch-off');
    expect(pending(sb)).toHaveLength(0);
  });

  describe('the three shapes a rebuild does not touch stay refused', () => {
    const CASES: Array<[string, string]> = [
      [
        'a parentless DO / GR / IV / PI',
        'created with no sales order, so there is no source document to transfer from. AutoCount '
        + 'builds a DO / GRN / Invoice only by transferring a source document\'s lines',
      ],
      [
        'a merged conversion with no AutoCount shape',
        'AutoCount transfers from ONE source document, and this delivery order draws on 2',
      ],
      [
        'a DtlKey-subset refusal',
        'this SO -> DO transfers only 2 of the source document\'s lines, and 1 of them carry no '
        + 'AutoCount DtlKey, so the ERP cannot name the subset.',
      ],
    ];

    for (const [name, reason] of CASES) {
      test(`${name} is refused by the button`, async () => {
        const sb = convWorld([skippedConversion(reason)], [{ id: 'do-9', linked_ac_docno: null }]);
        const before = JSON.stringify(rows(sb));
        const r = await requeueOutboxRow(asSb(sb), { rowId: 'conv-skip', companyId: 1 });
        expect(r.outcome).toBe('not-recoverable');
        expect(r.detail).toContain('parentless');
        expect(r.detail).toContain('merged conversion');
        expect(r.detail).toContain('DtlKey-subset');
        expect(JSON.stringify(rows(sb))).toBe(before);
        expect(pending(sb)).toHaveLength(0);
      });

      test(`${name} is refused by the batch sweep, with and without includeFailed`, async () => {
        for (const includeFailed of [false, true]) {
          const sb = convWorld([skippedConversion(reason)], [{ id: 'do-9', linked_ac_docno: null }]);
          const [r] = await requeueSkipped(asSb(sb), { docType: 'ALL', apply: true, includeFailed });
          expect(r.outcome, `includeFailed=${includeFailed}`).toBe('not-recoverable');
          expect(r.detail, `includeFailed=${includeFailed}`).toContain('parentless');
          expect(r.detail).toContain('merged conversion');
          expect(r.detail).toContain('DtlKey-subset');
          expect(pending(sb)).toHaveLength(0);
        }
      });
    }

    test('and a skipped conversion is refused even if a payload somehow survives on it', async () => {
      const sb = convWorld(
        [skippedConversion('created with no sales order, so there is no source document to transfer from.',
          { payload: doPayload() })],
        [{ id: 'do-9', linked_ac_docno: null }],
      );
      const r = await requeueOutboxRow(asSb(sb), { rowId: 'conv-skip', companyId: 1 });
      expect(r.outcome).toBe('not-recoverable');
      expect(pending(sb)).toHaveLength(0);
    });
  });

  test('a SENT conversion is refused by the button, with nothing written', async () => {
    const sb = convWorld([failedConversion({ status: 'sent', attempts: 1, last_error: null, ac_doc_no: 'DO-000112' })]);
    const before = JSON.stringify(rows(sb));
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'conv-1', companyId: 1 });
    expect(r.outcome).toBe('already-sent');
    expect(JSON.stringify(rows(sb))).toBe(before);
    expect(pending(sb)).toHaveLength(0);
  });

  test('and the batch sweep cannot even see it — its select is the guard there', async () => {
    const sb = convWorld([failedConversion({ status: 'sent', attempts: 1, last_error: null })]);
    const out = await requeueSkipped(asSb(sb), {
      docNo: 'HC-DO-2608-002', apply: true, includeFailed: true,
    });
    expect(out).toEqual([]);
    expect(pending(sb)).toHaveLength(0);
  });
});

describe('the ladder itself refuses a document AutoCount already has', () => {
  const sentRowOf = (op: string, docType: string, docNo: string): Row => ({
    id: `sent-${op}`, company_id: 1, op, doc_type: docType, doc_no: docNo, doc_id: 'x-1',
    payload: { body: { DocNo: docNo } }, status: 'sent', attempts: 1, dedupe_key: null,
    last_error: null, ac_doc_no: 'AC-1', created_at: '2026-08-16T02:00:00Z',
  });

  const OPS: Array<[string, string, string]> = [
    ['create_so', 'SO', 'HC-SO-2608-002'],
    ['create_po', 'PO', 'HC-PO-9'],
    ['so_to_do', 'DO', 'HC-DO-2608-002'],
    ['po_to_gr', 'GR', 'HC-GRN-000002'],
    ['do_to_iv', 'IV', 'HC-INV-000002'],
    ['gr_to_pi', 'PI', 'HC-PINV-000002'],
    ['so_to_po', 'PO', 'HC-PO-10'],
  ];

  for (const [op, docType, docNo] of OPS) {
    test(`${op}: already-sent, and NOT ONE WRITE`, async () => {
      const sb = fakeSb({
        app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
        autocount_outbox: [sentRowOf(op, docType, docNo)],
        mfg_sales_orders: [{ ...soWithoutLocation(), doc_no: docNo, sales_location: 'KL WAREHOUSE' }],
        mfg_sales_order_items: [{ ...soItem(), doc_no: docNo }],
        purchase_orders: [{ id: 'x-1', company_id: 1, po_number: docNo, po_date: '2026-08-12', supplier_id: 'sup-1', notes: null, linked_ac_docno: null }],
        suppliers: [{ id: 'sup-1', code: '400-H004', name: 'Supplier' }],
        purchase_order_items: [],
        delivery_orders: [{ id: 'x-1', linked_ac_docno: null }],
        grns: [{ id: 'x-1', linked_ac_docno: null }],
        sales_invoices: [{ id: 'x-1', linked_ac_docno: null }],
        purchase_invoices: [{ id: 'x-1', linked_ac_docno: null }],
        warehouses: [{ id: 'wh-1', code: 'KL', name: 'KL WAREHOUSE' }],
        supplier_material_bindings: [],
      }, { purchase_orders: ['creditor_code', 'creditor_name', 'agent', 'ref'] }, DEDUPE_IDX);
      const before = JSON.stringify(rows(sb));

      const r = await requeueOneRow(asSb(sb), asRow(sentRowOf(op, docType, docNo)), {
        apply: true, resendingThisRow: true,
      });

      expect(r.outcome).toBe('already-sent');
      expect(acRequeueAccepted(r.outcome)).toBe(false);
      expect(JSON.stringify(rows(sb))).toBe(before);
      expect(pending(sb)).toHaveLength(0);
    });
  }

  test('it refuses BEFORE the write-back switch is consulted, so OFF cannot change the answer', async () => {
    const sb = fakeSb({
      app_config: [{ key: 'scm.autocount_writeback', value: 'off' }],
      autocount_outbox: [sentRowOf('so_to_do', 'DO', 'HC-DO-2608-002')],
      delivery_orders: [{ id: 'x-1', linked_ac_docno: null }],
    }, {}, DEDUPE_IDX);
    const r = await requeueOneRow(asSb(sb), asRow(sentRowOf('so_to_do', 'DO', 'HC-DO-2608-002')), {
      apply: true, resendingThisRow: true,
    });
    expect(r.outcome).toBe('already-sent');
  });
});

/* ---------------------------------------------------------------------------
   THE PARENTLESS ROW THAT WAS NEVER PARENTLESS.

   Owner 2026-08-24: 「我的 GR PO 所有文件都要有 Send Now 的 button」and 「点击
   Send Now 的话，如果它之前上面的 documentation 没有进去，它就要补调进去」.

   Eight production receipts and supplier invoices carried "there is no earlier
   document to carry across" while their lines named a purchase order — the
   create path did not look (docs/bugs/0524). The claim being false is what
   makes withholding the button wrong, so these tests are about the DOCUMENT,
   not about the row: one receipt that really does come from a purchase order,
   and one that really was keyed in by hand.
   ------------------------------------------------------------------------ */
describe('a conversion recorded as parentless is re-read, not replayed', () => {
  const grnRow = (over: Partial<Row> = {}): Row => ({
    id: 'grn-1', company_id: 1, grn_number: 'HC-GRN-2608-002', linked_ac_docno: null, ...over,
  });
  const parentlessSkip = (over: Partial<Row> = {}): Row => ({
    id: 'skip-gr', company_id: 1, op: 'po_to_gr', doc_type: 'GR',
    doc_no: 'HC-GRN-2608-002', doc_id: 'grn-1', status: 'skipped',
    dedupe_key: 'po_to_gr:grn-1', attempts: 0,
    payload: { body: {} },
    last_error: 'created with no source Purchase Order to transfer from.',
    ...over,
  });
  const parented = (outbox: Row[] = [parentlessSkip()], grn: Row = grnRow()) => fakeSb({
    app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
    autocount_outbox: outbox,
    grns: [grn],
    grn_items: [{ id: 'gi-1', grn_id: 'grn-1', purchase_order_item_id: 'poi-1' }],
    purchase_order_items: [{ id: 'poi-1', purchase_order_id: 'po-1' }],
    purchase_orders: [{ id: 'po-1', company_id: 1, po_number: 'HC-PO-2608-002' }],
  }, {}, DEDUPE_IDX);
  const handEntered = () => fakeSb({
    app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
    autocount_outbox: [parentlessSkip()],
    grns: [grnRow()],
    grn_items: [{ id: 'gi-1', grn_id: 'grn-1', purchase_order_item_id: null }],
    purchase_order_items: [],
    purchase_orders: [],
  }, {}, DEDUPE_IDX);

  test('it gets a real conversion queued, and the old skip is annotated', async () => {
    const sb = parented();
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'skip-gr', companyId: 1 });
    expect(r.outcome).toBe('requeued-with-parent');
    expect(acRequeueAccepted(r.outcome)).toBe(true);
    const queued = pending(sb);
    expect(queued).toHaveLength(1);
    expect(queued[0].op).toBe('po_to_gr');
    expect(JSON.stringify(queued[0].payload)).toContain('po-1');
    expect(rows(sb).find((x) => x.id === 'skip-gr')?.last_error).toContain(REQUEUE_NOTE_PREFIX);
  });

  test('a receipt that really was keyed in by hand keeps the refusal', async () => {
    const sb = handEntered();
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'skip-gr', companyId: 1 });
    expect(r.outcome).toBe('not-recoverable');
    expect(pending(sb)).toHaveLength(0);
  });

  test('a receipt ALREADY in the account book is refused, not transferred twice', async () => {
    const sb = parented([parentlessSkip()], grnRow({ linked_ac_docno: 'GR-00123' }));
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'skip-gr', companyId: 1 });
    expect(r.outcome).toBe('already-in-autocount');
    expect(pending(sb)).toHaveLength(0);
  });

  test('a live row for the same receipt stops a second one being added', async () => {
    const sb = parented([
      parentlessSkip(),
      parentlessSkip({ id: 'live-gr', status: 'pending', last_error: null }),
    ]);
    const r = await requeueOutboxRow(asSb(sb), { rowId: 'skip-gr', companyId: 1 });
    expect(r.outcome).toBe('already-queued');
    expect(pending(sb)).toHaveLength(1);
  });
});
