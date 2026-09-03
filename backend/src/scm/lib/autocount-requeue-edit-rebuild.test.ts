// ----------------------------------------------------------------------------
// RE-SENDING A HELD-BACK EDIT REBUILDS THE DOCUMENT.
//
// The case this exists for is HC-SO-013394, held back since 2026-08-31 with one
// line of eight carrying no AutoCount key. Read off the live account book on
// 2026-09-02, its book side holds TEN lines to the ERP's eight and the item code
// `JM-CL JAC WP MP` appears three times there - so no matcher can ever choose
// between them, and the owner is right that matching lines by hand is not the
// answer: 「不需要 match up line 啊，这个 button 都没必要用了」.
//
// A rebuild is. It clears the book's details and lays the ERP's lines down, so
// the two sides finish identical - which is the whole ask.
//
// WHAT THIS FILE GUARDS IS THE BOUNDARY, not the happy path. A rebuild destroys
// and reissues every DtlKey, so it may happen ONLY when an operator re-sends a
// document that is already held back, and NEVER on an ordinary save
// (docs/bugs/0613), and NEVER on a document built by conversion, whose lines are
// where AutoCount records what it came from (docs/bugs/0611).
// ----------------------------------------------------------------------------
import { describe, expect, test, beforeEach } from 'vitest';
import { requeueOneRow } from './autocount-requeue';
import { enqueueEdit } from './autocount-outbox';
import { newLineTargetOf } from './autocount-line-keys';
import { fakeSb, type Row } from './fake-postgrest';
import { resetWritebackFlagCache } from './autocount-writeback-flag';

/* A real cutover code: the composer resolves every ERP code against the map and
   REFUSES what it cannot find, so an invented SKU would test that instead. */
const ERP_A = 'AKEMI APEX MATT (SP)';
const ERP_B = 'AKEMI ARISTOI MATT (SP)';
const SO_DOC = 'HC-SO-013394';

const soHeader = (): Row => ({
  doc_no: SO_DOC, so_date: '2026-08-29', debtor_name: 'ACME', agent: null,
  salesperson_id: 'staff-1', sales_location: 'KL', branding: null, venue: null,
  address1: null, address2: null, address3: null, address4: null,
  phone: null, ref: null, po_doc_no: null, internal_expected_dd: null,
  /* It IS in AutoCount - an edit is only ever composed for a document that is. */
  linked_ac_docno: 'SO-013394', company_id: 1,
});

/* SEVEN keyed, ONE not - the shape the live document is actually in. The keyless
   one is what makes a keyed edit impossible and a rebuild the only way through. */
const soItems = (): Row[] => ([
  { id: 'row-1', doc_no: SO_DOC, item_code: ERP_A, description: 'M', qty: 1, unit_price_sen: 100, cancelled: false, warehouse_id: null, linked_ac_dtlkey: 917137 },
  { id: 'row-2', doc_no: SO_DOC, item_code: ERP_B, description: 'M', qty: 1, unit_price_sen: 200, cancelled: false, warehouse_id: null, linked_ac_dtlkey: null },
]);

const editSkip = (extra: Row = {}): Row => ({
  id: 'skip-1', company_id: 1, op: 'edit', doc_type: 'SO', doc_no: SO_DOC,
  doc_id: null, payload: { body: {} }, status: 'skipped', attempts: 0,
  dedupe_key: null,
  last_error: 'refused, nothing sent (KeylessLineError): 1 of 8 line(s) carry no AutoCount DtlKey',
  created_at: '2026-08-31T02:00:00Z',
  ...extra,
});

const world = (outbox: Row[] = [editSkip()]) => fakeSb({
  app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
  autocount_outbox: outbox,
  staff: [{ id: 'staff-1', name: 'Nurul Hidayah' }],
  mfg_sales_orders: [soHeader()],
  mfg_sales_order_items: soItems(),
  supplier_material_bindings: [],
});

const rows = (sb: { tables: Record<string, Row[]> }) => sb.tables.autocount_outbox ?? [];
const queued = (sb: { tables: Record<string, Row[]> }) => rows(sb).filter((r) => r.status === 'pending');

beforeEach(() => resetWritebackFlagCache());

describe('an edit that was held back can be re-sent, as a rebuild', () => {
  test('APPLY queues an edit whose payload carries Rebuild', async () => {
    const sb = world();
    const r = await requeueOneRow(sb as never, editSkip() as never, { apply: true, resendingThisRow: false });

    expect(r.outcome).toBe('requeued');
    const [row] = queued(sb);
    expect(row, 'nothing was queued').toBeTruthy();
    /* The PAYLOAD, not the verdict text. What reaches the host is the only thing
       that decides whether the book ends up matching the ERP. */
    expect((row.payload as { body: Record<string, unknown> }).body.Rebuild).toBe(true);
  });

  test('DRY RUN says it would, and writes nothing', async () => {
    const sb = world();
    const before = JSON.stringify(rows(sb));
    const r = await requeueOneRow(sb as never, editSkip() as never, { apply: false, resendingThisRow: false });

    expect(r.outcome).toBe('would-requeue');
    expect(r.detail).toContain('REBUILD');
    expect(JSON.stringify(rows(sb))).toBe(before);
  });
});

describe('the two refusals a rebuild must never get past', () => {
  /* docs/bugs/0611. A delivery order was CREATED BY TRANSFER and its lines hold
     FromDocType / FromDocNo. Clearing them destroys the conversion, and the
     host's own guard cannot see it - AnyLineTransferred reads TransferedQty,
     which is what this document passed ONWARD. So the ERP does not ask. */
  test('a document built by conversion is refused, and the reason says why', async () => {
    const sb = world([editSkip({ doc_type: 'DO', doc_id: 'do-1' })]);
    const r = await requeueOneRow(
      sb as never,
      editSkip({ doc_type: 'DO', doc_id: 'do-1' }) as never,
      { apply: true, resendingThisRow: false },
    );

    expect(r.outcome).toBe('not-recoverable');
    expect(r.detail).toContain('converted FROM');
    expect(queued(sb)).toHaveLength(0);
  });

  /* docs/bugs/0613, and the reason this is a REQUEUE and not a save behaviour:
     the very same document, saved normally, must still refuse rather than
     silently reissue every key on it. */
  test('an ordinary save of the same document does NOT rebuild - it still refuses', async () => {
    const sb = fakeSb({
      app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
      autocount_outbox: [],
      staff: [{ id: 'staff-1', name: 'Nurul Hidayah' }],
      mfg_sales_orders: [soHeader()],
      mfg_sales_order_items: soItems(),
      supplier_material_bindings: [],
    });

    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: SO_DOC })).toBe(false);
    const written = rows(sb);
    expect(written).toHaveLength(1);
    expect(written[0].status).toBe('skipped');
    expect(String(written[0].last_error)).toContain('DtlKey');
  });
});

describe('a rebuilt line is a NEW line, so it must carry its item code', () => {
  /* THE DEFECT THIS EXISTS FOR, and it reached a live account book. composeEdit
     strips ItemCode from every keyed line on purpose: the ERP's answer for the
     collapsed sofa codes is a POLICY, and sending it would silently move the 194
     real book lines those two brand items hold. Right for an EDIT. A REBUILD is
     not an edit - it clears the details and ADDS the lines - so a line with no
     item code is added blank.

     Measured on SO-013394 on 2026-09-02, after the first rebuild reached the
     book: seven of eight lines came back with ItemCode = '' and every log line
     was green, because the host wrapped the assignment in Set(), which swallows.
     docs/bugs/0615. */
  test('every line in a rebuild payload carries an ItemCode', async () => {
    const sb = world();
    await requeueOneRow(sb as never, editSkip() as never, { apply: true, resendingThisRow: false });

    const body = (queued(sb)[0].payload as { body: { Lines: Array<Record<string, unknown>>; Rebuild?: unknown } }).body;
    expect(body.Rebuild).toBe(true);
    expect(body.Lines.length).toBeGreaterThan(0);
    for (const [i, line] of body.Lines.entries()) {
      expect(String(line.ItemCode ?? ''), `line ${i + 1} would be added blank`).not.toBe('');
    }
  });

  /* THE HALF THAT MUST NOT MOVE. An ordinary keyed edit still omits ItemCode -
     that strip is the only thing standing between an edit and 194 silently
     re-pointed lines, and this fix must not have widened it. */
  test('an ordinary keyed edit still sends no ItemCode at all', async () => {
    const sb = fakeSb({
      app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
      autocount_outbox: [],
      staff: [{ id: 'staff-1', name: 'Nurul Hidayah' }],
      mfg_sales_orders: [soHeader()],
      /* Every line KEYED, so the edit composes instead of refusing. */
      mfg_sales_order_items: soItems().map((r) => ({ ...r, linked_ac_dtlkey: r.linked_ac_dtlkey ?? 917138 })),
      supplier_material_bindings: [],
    });

    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: SO_DOC })).toBe(true);
    const body = (rows(sb)[0].payload as { body: { Lines: Array<Record<string, unknown>>; Rebuild?: unknown } }).body;
    expect(body.Rebuild).toBeUndefined();
    for (const line of body.Lines) expect(line).not.toHaveProperty('ItemCode');
  });
});

describe('after a rebuild the ERP has to learn the reissued keys', () => {
  /* THE LOOSE END THIS CLOSES, and it was live. A rebuild clears the details and
     re-adds them, so every key the book returns is NEW - and the ERP went on
     holding the keys of lines that no longer existed. Measured on HC-SO-013394
     after two rebuilds: the ERP still reported "7 of 8 lines carry a key", the
     same split as before, while the book's keys had moved to 919855-919862. The
     next ordinary edit of that document would have sent EditDetail(<dead key>)
     and failed. docs/bugs/0621. */
  test('every rebuilt line names the ERP rows behind it', async () => {
    const sb = world();
    await requeueOneRow(sb as never, editSkip() as never, { apply: true, resendingThisRow: false });

    const body = (queued(sb)[0].payload as { body: { Lines: Array<Record<string, unknown>> } }).body;
    for (const [i, line] of body.Lines.entries()) {
      expect(Array.isArray(line.ErpLineIds), `line ${i + 1} names no ERP row`).toBe(true);
      expect((line.ErpLineIds as string[]).length, `line ${i + 1} names no ERP row`).toBeGreaterThan(0);
    }
  });

  /* And the reader has to agree with the writer: on a rebuild EVERY line counts
     as new and NOT ONE key the payload carried is still known, or
     persistNewLineKeys would filter a genuinely fresh key out as "already had
     it" and then bail on the count mismatch. */
  test('newLineTargetOf treats a rebuild as all-new with no known keys', async () => {
    const sb = world();
    await requeueOneRow(sb as never, editSkip() as never, { apply: true, resendingThisRow: false });
    const payload = queued(sb)[0].payload as { body: { Lines: Array<Record<string, unknown>> } };

    const target = newLineTargetOf('SO', payload);
    expect(target, 'a rebuild names no lines to store').not.toBeNull();
    expect(target?.newIds).toHaveLength(payload.body.Lines.length);
    expect(target?.knownKeys).toEqual([]);
  });

  /* THE HALF THAT MUST NOT MOVE. An ordinary edit still stores only what the
     route DECLARED new - reading every line back would repoint keys the book
     already owns. */
  test('an ordinary edit still names nothing new', async () => {
    const sb = fakeSb({
      app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
      autocount_outbox: [],
      staff: [{ id: 'staff-1', name: 'Nurul Hidayah' }],
      mfg_sales_orders: [soHeader()],
      mfg_sales_order_items: soItems().map((r) => ({ ...r, linked_ac_dtlkey: r.linked_ac_dtlkey ?? 917138 })),
      supplier_material_bindings: [],
    });

    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: SO_DOC })).toBe(true);
    expect(newLineTargetOf('SO', rows(sb)[0].payload as { body?: unknown })).toBeNull();
  });
});
