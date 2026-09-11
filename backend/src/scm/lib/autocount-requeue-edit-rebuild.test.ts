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
import { requeueOneRow, requeueSkipped, REQUEUE_PUTS_IT_ON_ITS_WAY } from './autocount-requeue';
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

// ----------------------------------------------------------------------------
// ONE REBUILD PER DOCUMENT, however many times it was refused.
//
// HC-SO-012312 was saved twenty-one times while its Description 2 was over
// AutoCount's 100 characters, so the queue holds twenty-one refused edits of one
// sales order. Once the composer accepted it, the sweep climbed the ladder
// twenty-one times and answered `would-requeue 21` — which APPLY would have made
// twenty-one InternalSaves against a live licensed account book, each one
// destroying and reissuing every DtlKey on the document.
//
// A rebuild does not accumulate. It lays down the ERP's lines AS THEY STAND, so
// the first one already carries what all twenty-one saves added up to, and the
// other twenty are the same instruction sent again.
// ----------------------------------------------------------------------------
describe('a document refused many times is re-queued ONCE', () => {
  const manySkips = (n: number): Row[] => Array.from({ length: n }, (_, i) => editSkip({
    id: `skip-${i + 1}`,
    created_at: `2026-09-0${(i % 8) + 1}T02:00:00Z`,
  }));

  test('APPLY queues one pending row for twenty-one refusals', async () => {
    const sb = world(manySkips(21));
    const results = await requeueSkipped(sb as never, { docNo: SO_DOC, apply: true });

    expect(results).toHaveLength(21);
    expect(results.filter((r) => r.outcome === 'requeued')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'already-queued')).toHaveLength(20);
    /* The measurement that matters is not the verdict, it is the QUEUE. */
    expect(queued(sb)).toHaveLength(1);
  });

  test('the DRY RUN predicts the same one, not twenty-one', async () => {
    /* The dry run writes no pending row, so the database guard cannot answer
       for it. Without the sweep's own memory an operator would read
       `would-requeue 21` for a run that lands 1 — and this file's promise is
       that a dry run can only disagree with APPLY about whether the row lands. */
    const sb = world(manySkips(21));
    const results = await requeueSkipped(sb as never, { docNo: SO_DOC });

    expect(results.filter((r) => r.outcome === 'would-requeue')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'already-queued')).toHaveLength(20);
    expect(queued(sb)).toHaveLength(0);
  });

  test('a PENDING row already on the document refuses the rebuild outright', async () => {
    const sb = world([
      editSkip(),
      { ...editSkip({ id: 'live-1' }), status: 'pending', last_error: null },
    ]);
    const r = await requeueOneRow(sb as never, editSkip() as never, { apply: true, resendingThisRow: false });

    expect(r.outcome).toBe('already-queued');
    expect(queued(sb)).toHaveLength(1);
  });

  test('a SENT edit in the document\'s history does NOT refuse it', async () => {
    /* The rung this mirrors is `row-pending`, not `already-sent`. A document the
       write-back has succeeded on carries a `sent` edit row for every save it
       ever made — vetoing on those would refuse every document that has ever
       worked. */
    const sb = world([
      editSkip(),
      { ...editSkip({ id: 'old-1' }), status: 'sent', last_error: null },
    ]);
    const r = await requeueOneRow(sb as never, editSkip() as never, { apply: true, resendingThisRow: false });

    expect(r.outcome).toBe('requeued');
    expect(queued(sb)).toHaveLength(1);
  });

  test('the collapse is per DOCUMENT — a second order is still re-queued', async () => {
    const OTHER = 'HC-SO-013395';
    const sb = fakeSb({
      app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
      autocount_outbox: [
        editSkip({ id: 'a1' }),
        editSkip({ id: 'a2' }),
        editSkip({ id: 'b1', doc_no: OTHER }),
        editSkip({ id: 'b2', doc_no: OTHER }),
      ],
      staff: [{ id: 'staff-1', name: 'Nurul Hidayah' }],
      mfg_sales_orders: [soHeader(), { ...soHeader(), doc_no: OTHER, linked_ac_docno: 'SO-013395' }],
      mfg_sales_order_items: [
        ...soItems(),
        ...soItems().map((r, i) => ({ ...r, id: `other-${i}`, doc_no: OTHER })),
      ],
      supplier_material_bindings: [],
    });

    const results = await requeueSkipped(sb as never, { docType: 'SO', apply: true });

    expect(results.filter((r) => r.outcome === 'requeued').map((r) => r.docNo).sort())
      .toEqual([OTHER, SO_DOC].sort());
    expect(queued(sb)).toHaveLength(2);
  });
});

describe('the outcomes that mean a document is on its way', () => {
  test('every re-queue verdict is in the set the sweep dedupes on', () => {
    /* Forgetting one is silent: the document is simply re-queued a second time,
       which is the whole defect. `requeued-with-parent` is the one that reads
       like a special case and would be the one left out. */
    expect([...REQUEUE_PUTS_IT_ON_ITS_WAY].sort()).toEqual([
      'requeued', 'requeued-as-recorded', 'requeued-with-parent', 'would-requeue',
    ]);
  });
});
