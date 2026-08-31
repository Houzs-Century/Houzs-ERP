// THE DRAIN: what the 5-minute sweep does with a queued row.
//
// SPLIT OUT OF autocount-outbox.test.ts on 2026-08-18, when the photograph and
// host-build cases pushed that file over the 2,000-line cap. The seam is the
// one the module already has: everything here is about DISPATCH — resolving a
// parent, ensuring masters, what a refusal does to attempts, and what gets
// stamped on the row — and nothing about what a route decides to ENQUEUE.
import { AC_DEBTOR_CODE } from '../../services/autocount-writeback';
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { dispatchOne, MAX_ATTEMPTS, type AcOutboxRow } from './autocount-outbox';
import { resetWritebackFlagCache } from './autocount-writeback-flag';
import { fakeSb, type Row } from './fake-postgrest';

const SALESPERSON = { id: 'staff-1', name: 'Nurul Hidayah' };

const withFlag = (value: string | null, extra: Record<string, Row[]> = {}, missing: Record<string, string[]> = {}) =>
  fakeSb({
    app_config: value == null ? [] : [{ key: 'scm.autocount_writeback', value }],
    autocount_outbox: [],
    staff: [{ ...SALESPERSON }],
    ...extra,
  }, missing);

const outbox = (sb: { tables: Record<string, Row[]> }) => sb.tables.autocount_outbox ?? [];

beforeEach(() => resetWritebackFlagCache());

describe('the drain', () => {
  const env = { AC_SYNC_URL: 'http://ac.local:8900', AC_SYNC_KEY: 'k' } as unknown as Record<string, unknown>;
  const row = (over: Partial<AcOutboxRow> = {}): AcOutboxRow => ({
    id: 'ob-1',
    company_id: 1,
    op: 'create_so',
    doc_type: 'SO',
    doc_no: 'HC-SO-9',
    doc_id: null,
    payload: { body: { DocNo: 'HC-SO-9' }, writeback: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' } },
    status: 'pending',
    attempts: 0,
    dedupe_key: 'create_so:HC-SO-9',
    ...over,
  });

  const jsonRes = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  test('success marks the row sent AND records the AutoCount number back onto the ERP document', async () => {
    const sb = withFlag('1', {
      autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }],
      mfg_sales_orders: [{ doc_no: 'HC-SO-9', linked_ac_docno: null }],
    });
    const fetchImpl = vi.fn(async () => jsonRes(200, { ok: true, docNo: 'SO-000123' })) as never;

    expect(await dispatchOne(env as never, sb as never, row(), fetchImpl)).toBe('sent');
    expect(outbox(sb)[0].status).toBe('sent');
    expect(outbox(sb)[0].ac_doc_no).toBe('SO-000123');
    // The other half of the relationship map: ERP row -> AutoCount document.
    expect(sb.tables.mfg_sales_orders[0].linked_ac_docno).toBe('SO-000123');
  });

  /* Line identity, the half that closes the loop. A create that does not record
     the DtlKeys it was given leaves the document keyless forever, and its first
     edit is then refused by composeEdit. */
  const lineRow = () => row({
    payload: {
      body: { DocNo: 'HC-SO-9' },
      writeback: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
      lineWriteback: { table: 'mfg_sales_order_items', ids: ['li-1', 'li-2'], codes: ['SKU-1', 'SKU-2'] },
    },
  });

  const twoLines = () => ({
    autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }],
    mfg_sales_orders: [{ doc_no: 'HC-SO-9', linked_ac_docno: null }],
    mfg_sales_order_items: [
      { id: 'li-1', item_code: 'SKU-1', linked_ac_dtlkey: null },
      { id: 'li-2', item_code: 'SKU-2', linked_ac_dtlkey: null },
    ],
  });

  test('the DtlKeys a create returns are stored onto the ERP lines', async () => {
    const sb = withFlag('1', twoLines());
    const fetchImpl = vi.fn(async () => jsonRes(200, {
      ok: true,
      docNo: 'SO-000123',
      lines: [
        { Seq: 0, DtlKey: 5001, ItemCode: 'SKU-1' },
        { Seq: 1, DtlKey: 5002, ItemCode: 'SKU-2' },
      ],
    })) as never;

    expect(await dispatchOne(env as never, sb as never, lineRow(), fetchImpl)).toBe('sent');
    expect(sb.tables.mfg_sales_order_items[0].linked_ac_dtlkey).toBe(5001);
    expect(sb.tables.mfg_sales_order_items[1].linked_ac_dtlkey).toBe(5002);
  });

  /* AN EDIT THAT ADDED A LINE has to learn that line's key too, and until
     2026-08-31 it did not. HC-SO-013394: the add went through, AutoCount
     appended the line and gave it a key, the ERP row stayed NULL — and every
     later edit of that order was refused with "the ERP cannot tell which lines
     AutoCount already has", which "send again" cannot clear.

     The zip here is NOT the create path's by-position one. The book orders by
     DtlKey (the document's original insertion order) and the payload is in ERP
     line order, so the only sound reading is the DIFFERENCE: a key the payload
     did not already carry is one this edit created. */
  const editRow = () => row({
    op: 'edit',
    dedupe_key: null,
    payload: {
      body: {
        DocNo: 'SO-000123',
        Lines: [
          { DtlKey: 5001, ItemCode: 'SKU-1' },
          { ItemCode: 'SKU-NEW', IsNewLine: true, ErpLineIds: ['li-2'] },
        ],
      },
    },
  });

  test('an edit that added a line stores the key AutoCount gave it', async () => {
    const sb = withFlag('1', {
      autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }],
      mfg_sales_orders: [{ doc_no: 'HC-SO-9', linked_ac_docno: 'SO-000123' }],
      mfg_sales_order_items: [
        { id: 'li-1', item_code: 'SKU-1', linked_ac_dtlkey: 5001 },
        { id: 'li-2', item_code: 'SKU-NEW', linked_ac_dtlkey: null },
      ],
    });
    const fetchImpl = vi.fn(async () => jsonRes(200, {
      ok: true,
      lines: [
        { Seq: 0, DtlKey: 5001, ItemCode: 'SKU-1' },
        { Seq: 1, DtlKey: 5099, ItemCode: 'SKU-NEW' },
      ],
    })) as never;

    expect(await dispatchOne(env as never, sb as never, editRow(), fetchImpl)).toBe('sent');
    expect(sb.tables.mfg_sales_order_items[1].linked_ac_dtlkey).toBe(5099);
    // The line that already had a key is left exactly as it was.
    expect(sb.tables.mfg_sales_order_items[0].linked_ac_dtlkey).toBe(5001);
  });

  /* THE OLD EXE. A service built before this change answers an edit with no
     line list at all. That must be a no-op, not a complaint and not a failure —
     it is precisely today's behaviour, and the deploy happens on its own clock. */
  test('an edit answered by a service that reports no lines stores nothing and still succeeds', async () => {
    const sb = withFlag('1', {
      autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }],
      mfg_sales_orders: [{ doc_no: 'HC-SO-9', linked_ac_docno: 'SO-000123' }],
      mfg_sales_order_items: [
        { id: 'li-1', item_code: 'SKU-1', linked_ac_dtlkey: 5001 },
        { id: 'li-2', item_code: 'SKU-NEW', linked_ac_dtlkey: null },
      ],
    });
    const fetchImpl = vi.fn(async () => jsonRes(200, { ok: true })) as never;

    expect(await dispatchOne(env as never, sb as never, editRow(), fetchImpl)).toBe('sent');
    expect(sb.tables.mfg_sales_order_items[1].linked_ac_dtlkey).toBeNull();
  });

  /* Fails CLOSED. The book reports two keys the payload did not carry while the
     ERP declared one new line: the two lists do not correspond, so nothing is
     stored and the line stays keyless — refused loudly on the next edit rather
     than silently pointed at somebody else's line. */
  test('an edit whose new-line count disagrees with the book stores nothing', async () => {
    const sb = withFlag('1', {
      autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }],
      mfg_sales_orders: [{ doc_no: 'HC-SO-9', linked_ac_docno: 'SO-000123' }],
      mfg_sales_order_items: [
        { id: 'li-1', item_code: 'SKU-1', linked_ac_dtlkey: 5001 },
        { id: 'li-2', item_code: 'SKU-NEW', linked_ac_dtlkey: null },
      ],
    });
    const fetchImpl = vi.fn(async () => jsonRes(200, {
      ok: true,
      lines: [
        { Seq: 0, DtlKey: 5001, ItemCode: 'SKU-1' },
        { Seq: 1, DtlKey: 5099, ItemCode: 'SKU-NEW' },
        { Seq: 2, DtlKey: 5100, ItemCode: 'SOMEBODY-ELSE' },
      ],
    })) as never;

    expect(await dispatchOne(env as never, sb as never, editRow(), fetchImpl)).toBe('sent');
    expect(sb.tables.mfg_sales_order_items[1].linked_ac_dtlkey).toBeNull();
  });

  /* A WRONG key is worse than no key: no key is refused loudly by composeEdit,
     a wrong key silently edits a different line in a live account book. So a
     zip that cannot be proven correct stores NOTHING. */
  test('a line list that does not correspond stores no keys at all', async () => {
    const sb = withFlag('1', twoLines());
    const fetchImpl = vi.fn(async () => jsonRes(200, {
      ok: true,
      docNo: 'SO-000123',
      lines: [
        { Seq: 0, DtlKey: 5001, ItemCode: 'SKU-1' },
        { Seq: 1, DtlKey: 5002, ItemCode: 'SOMETHING-ELSE' },
      ],
    })) as never;

    expect(await dispatchOne(env as never, sb as never, lineRow(), fetchImpl)).toBe('sent');
    expect(sb.tables.mfg_sales_order_items[0].linked_ac_dtlkey).toBeNull();
    expect(sb.tables.mfg_sales_order_items[1].linked_ac_dtlkey).toBeNull();
  });

  test('a count that disagrees stores no keys at all', async () => {
    const sb = withFlag('1', twoLines());
    const fetchImpl = vi.fn(async () => jsonRes(200, {
      ok: true,
      docNo: 'SO-000123',
      lines: [{ Seq: 0, DtlKey: 5001, ItemCode: 'SKU-1' }],
    })) as never;

    expect(await dispatchOne(env as never, sb as never, lineRow(), fetchImpl)).toBe('sent');
    expect(sb.tables.mfg_sales_order_items[0].linked_ac_dtlkey).toBeNull();
  });

  /* An AcSyncService built before 2026-08-11 returns no `lines` at all, and the
     new one degrades to an empty array rather than losing the DocNo when its
     own read-back fails. Neither is a failure of the create. */
  test('a service that returns no lines still counts as sent', async () => {
    const sb = withFlag('1', twoLines());
    const fetchImpl = vi.fn(async () => jsonRes(200, { ok: true, docNo: 'SO-000123' })) as never;

    expect(await dispatchOne(env as never, sb as never, lineRow(), fetchImpl)).toBe('sent');
    expect(outbox(sb)[0].status).toBe('sent');
    expect(sb.tables.mfg_sales_orders[0].linked_ac_docno).toBe('SO-000123');
    expect(sb.tables.mfg_sales_order_items[0].linked_ac_dtlkey).toBeNull();
  });

  test('an unreachable AutoCount host is retried, not lost', async () => {
    const sb = withFlag('1', { autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }] });
    const fetchImpl = vi.fn(async () => { throw new Error('tunnel down'); }) as never;

    expect(await dispatchOne(env as never, sb as never, row(), fetchImpl)).toBe('retry');
    const after = outbox(sb)[0];
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(1);
    expect(after.last_error).toContain('tunnel down');
  });

  test('the last allowed attempt gives up, and says how many it took', async () => {
    const sb = withFlag('1', { autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: MAX_ATTEMPTS - 1 }] });
    const fetchImpl = vi.fn(async () => { throw new Error('tunnel down'); }) as never;

    expect(await dispatchOne(env as never, sb as never, row({ attempts: MAX_ATTEMPTS - 1 }), fetchImpl)).toBe('failed');
    const after = outbox(sb)[0];
    expect(after.status).toBe('failed');
    expect(after.attempts).toBe(MAX_ATTEMPTS);
    expect(after.last_error).toContain(`Gave up after ${MAX_ATTEMPTS} attempts`);
  });

  test("AutoCount's own refusal is kept verbatim and not retried into the ground", async () => {
    const sb = withFlag('1', { autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }] });
    const fetchImpl = vi.fn(async () => jsonRes(400, { ok: false, error: 'DocNo already exists' })) as never;

    expect(await dispatchOne(env as never, sb as never, row(), fetchImpl)).toBe('failed');
    const after = outbox(sb)[0];
    expect(after.status).toBe('failed');
    expect(after.attempts).toBe(1);
    expect(after.last_error).toBe('DocNo already exists');
  });

  test('a conversion waits for its parent instead of burning attempts', async () => {
    const sb = withFlag('1', {
      autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }],
      mfg_sales_orders: [{ doc_no: 'HC-SO-9', linked_ac_docno: null }],
    });
    const fetchImpl = vi.fn(async () => jsonRes(200, { ok: true, docNo: 'DO-1' })) as never;

    const outcome = await dispatchOne(env as never, sb as never, row({
      op: 'so_to_do',
      doc_type: 'DO',
      payload: {
        body: {},
        fromDoc: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
        writeback: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
      },
    }), fetchImpl);

    expect(outcome).toBe('waiting');
    expect(fetchImpl).not.toHaveBeenCalled();
    const after = outbox(sb)[0];
    expect(after.status).toBe('pending');
    expect(after.attempts ?? 0).toBe(0);
  });

  test('once the parent has an AutoCount number the conversion goes, carrying FromDocNo', async () => {
    const sb = withFlag('1', {
      autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }],
      mfg_sales_orders: [{ doc_no: 'HC-SO-9', linked_ac_docno: 'SO-000123' }],
      delivery_orders: [{ id: 'do-1', linked_ac_docno: null }],
    });
    const sent: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return jsonRes(200, { ok: true, docNo: 'DO-000045' });
    }) as never;

    expect(await dispatchOne(env as never, sb as never, row({
      op: 'so_to_do',
      doc_type: 'DO',
      payload: {
        body: {},
        fromDoc: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
        writeback: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
      },
    }), fetchImpl)).toBe('sent');

    expect(sent[0]).toMatchObject({ FromDocNo: 'SO-000123' });
    expect(sb.tables.delivery_orders[0].linked_ac_docno).toBe('DO-000045');
  });

  /* ── A MERGE NAMES EVERY SOURCE, OR IT WAITS ──────────────────────────────
     The service takes `FromDocNos` (PlanTransfer, AcSyncService.cs) and either
     FullTransfers the array or groups the named keys per source document. What
     the drain must not do is send a merge with only the sources that happen to
     be ready: AutoCount would hold a delivery order carrying one sales order's
     lines while the ERP's own document carries two, and the row would be `sent`
     so nothing would ever look at it again. */
  /* ── THE PHOTOGRAPHS ──────────────────────────────────────────────────────
     Proven against the live book on scratch order ERP-FDPROBE-1 (2026-08-15):
     the ERP sends JPEG bytes, the host renders a metafile, AutoCount stores
     them verbatim and the picture appears on the entry screen AND the printed
     document. What was missing was only this half — the ERP never sent any. */
  const photoEnv = (bytes: Record<string, string>) => ({
    ...env,
    SO_ITEM_PHOTOS: {
      get: async (k: string) => (bytes[k] === undefined ? null : {
        arrayBuffer: async () => new TextEncoder().encode(bytes[k]).buffer,
      }),
    },
  }) as never;

  test('an edit carries the line photographs as base64, fetched at send time', async () => {
    const sb = withFlag('1', { autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }] });
    const sent: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return jsonRes(200, { ok: true });
    }) as never;

    await dispatchOne(photoEnv({ 'so-items/a/1/ac-9001-1.jpg': 'PIC-ONE' }), sb as never, row({
      op: 'edit',
      doc_type: 'SO',
      payload: {
        body: { DocType: 'SO', DocNo: 'SO-1', Header: {}, Lines: [{ DtlKey: 9001, ItemCode: 'X' }] },
        photos: [{ dtlKey: 9001, keys: ['so-items/a/1/ac-9001-1.jpg'] }],
      },
    }), fetchImpl);

    /* The LAST call, not the first: an edit pre-flights /ensure-masters, so
       sent[0] is the master list and the document follows it. */
    const edit = sent[sent.length - 1];
    const line = (edit.Lines as Array<Record<string, unknown>>)[0];
    expect(line.Photos).toEqual([{ Jpeg: btoa('PIC-ONE') }]);
  });

  test('a picture the bucket cannot answer sends NO Photos key, and the edit still goes', async () => {
    /* Sending a SHORT list would overwrite five pictures in the book with
       three, and the service applies Photos by REPLACING FurtherDescription.
       Omitting the key leaves whatever the account book holds — and a
       photograph must never cost a price change its trip to the ledger. */
    const sb = withFlag('1', { autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }] });
    const sent: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return jsonRes(200, { ok: true });
    }) as never;

    const outcome = await dispatchOne(photoEnv({ 'have.jpg': 'ONE' }), sb as never, row({
      op: 'edit',
      doc_type: 'SO',
      payload: {
        body: { DocType: 'SO', DocNo: 'SO-1', Header: {}, Lines: [{ DtlKey: 9001, ItemCode: 'X' }] },
        photos: [{ dtlKey: 9001, keys: ['have.jpg', 'gone.jpg'] }],
      },
    }), fetchImpl);

    expect(outcome).toBe('sent');
    const edit = sent[sent.length - 1];
    const line = (edit.Lines as Array<Record<string, unknown>>)[0];
    expect(line.Photos).toBeUndefined();
  });

  /* ── WHICH BUILD ANSWERED (migration 0303) ────────────────────────────────
     A feature the host does not have is indistinguishable from a feature that
     ran and found nothing. /health has always known; nothing stored it. */
  test('the host build is stamped on the row the sweep sent', async () => {
    const sb = withFlag('1', {
      autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }],
      delivery_orders: [{ id: 'do-1', linked_ac_docno: null }],
    });
    const fetchImpl = vi.fn(async () => jsonRes(200, { ok: true, docNo: 'SO-1' })) as never;
    await dispatchOne(env as never, sb as never, row(), fetchImpl, {
      host_built_at: '2026-08-18T04:00:00Z', host_mvid: 'abc-123',
    });
    const after = outbox(sb)[0];
    expect(after.status).toBe('sent');
    expect(after.host_built_at).toBe('2026-08-18T04:00:00Z');
    expect(after.host_mvid).toBe('abc-123');
  });

  test('a row left WAITING is not stamped — nothing was sent for it', async () => {
    /* Stamping a build onto a row no call was made for would record a
       conversation that never happened, and that row is exactly the one someone
       will later read to ask "which service refused this". */
    const sb = withFlag('1', {
      autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }],
      mfg_sales_orders: [{ doc_no: 'HC-SO-9', linked_ac_docno: null }],
    });
    const fetchImpl = vi.fn(async () => jsonRes(200, { ok: true, docNo: 'DO-1' })) as never;
    const outcome = await dispatchOne(env as never, sb as never, row({
      op: 'so_to_do',
      doc_type: 'DO',
      payload: {
        body: {},
        fromDoc: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
        writeback: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
      },
    }), fetchImpl, { host_built_at: '2026-08-18T04:00:00Z', host_mvid: 'abc-123' });
    expect(outcome).toBe('waiting');
    expect(outbox(sb)[0].host_built_at).toBeUndefined();
  });

  test('no build known still sends the document — a diagnostic must not cost a sale', async () => {
    const sb = withFlag('1', {
      autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }],
      delivery_orders: [{ id: 'do-1', linked_ac_docno: null }],
    });
    const fetchImpl = vi.fn(async () => jsonRes(200, { ok: true, docNo: 'SO-1' })) as never;
    expect(await dispatchOne(env as never, sb as never, row(), fetchImpl, null)).toBe('sent');
    expect(outbox(sb)[0].host_built_at).toBeUndefined();
  });

  test('a merged conversion carries FromDocNos, one entry per source', async () => {
    const sb = withFlag('1', {
      autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }],
      mfg_sales_orders: [
        { doc_no: 'HC-SO-9', linked_ac_docno: 'SO-000123' },
        { doc_no: 'HC-SO-10', linked_ac_docno: 'SO-000124' },
      ],
      delivery_orders: [{ id: 'do-1', linked_ac_docno: null }],
    });
    const sent: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return jsonRes(200, { ok: true, docNo: 'DO-000046' });
    }) as never;

    expect(await dispatchOne(env as never, sb as never, row({
      op: 'so_to_do',
      doc_type: 'DO',
      payload: {
        body: {},
        fromDocs: [
          { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
          { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-10' },
        ],
        writeback: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
      },
    }), fetchImpl)).toBe('sent');

    expect(sent[0]).toMatchObject({ FromDocNos: ['SO-000123', 'SO-000124'] });
    /* The single-source field stays absent: the service reads FromDocNo as the
       fallback for FromDocNos, so sending both would be two answers to one
       question. */
    expect((sent[0] as { FromDocNo?: unknown }).FromDocNo).toBeUndefined();
  });

  test('a merge whose SECOND source has no AutoCount number waits, and sends nothing', async () => {
    const sb = withFlag('1', {
      autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }],
      mfg_sales_orders: [
        { doc_no: 'HC-SO-9', linked_ac_docno: 'SO-000123' },
        { doc_no: 'HC-SO-10', linked_ac_docno: null },
      ],
      delivery_orders: [{ id: 'do-1', linked_ac_docno: null }],
    });
    const fetchImpl = vi.fn(async () => jsonRes(200, { ok: true, docNo: 'DO-1' })) as never;

    expect(await dispatchOne(env as never, sb as never, row({
      op: 'so_to_do',
      doc_type: 'DO',
      payload: {
        body: {},
        fromDocs: [
          { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
          { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-10' },
        ],
        writeback: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
      },
    }), fetchImpl)).toBe('waiting');

    expect(fetchImpl).not.toHaveBeenCalled();
    const after = outbox(sb)[0];
    expect(after.status).toBe('pending');
    expect(after.attempts ?? 0).toBe(0);
    expect(after.last_error).toContain('1 of 2 source document(s)');
  });

/* ---------------------------------------------------------------------------
   THE CUSTOMER ON A ROW COMPOSED BEFORE #2340.

   HC-DO-2608-003 failed on production with the contentless "Invalid transfer
   item.", and five sales invoices behind it waited on a parent that could never
   arrive. AcSyncService.cs:988 names the cause: the target had no DebtorCode
   when the transfer ran, and AddPartialTransferDetail reports a debtor-less
   target as an invalid ITEM rather than as a missing account.

   The enqueue has supplied it since #2340. The drain replays a stored payload
   and never recomposes, so rows queued before that line still went out bare.
   ------------------------------------------------------------------------ */
describe('a sales conversion always names the customer, however old the row is', () => {
  const goSalesConversion = async (body: Record<string, unknown>) => {
    const sb = withFlag('1', {
      autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }],
      mfg_sales_orders: [{ doc_no: 'HC-SO-9', linked_ac_docno: 'SO-000123' }],
      delivery_orders: [{ id: 'do-1', linked_ac_docno: null }],
    });
    const sent: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return jsonRes(200, { ok: true, docNo: 'DO-000045' });
    }) as never;
    const outcome = await dispatchOne(env as never, sb as never, row({
      op: 'so_to_do',
      doc_type: 'DO',
      payload: {
        body,
        fromDoc: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
        writeback: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
      },
    }), fetchImpl);
    return { outcome, sent };
  };

  test('a payload stored with no DebtorCode has one by the time it is sent', async () => {
    const { outcome, sent } = await goSalesConversion({});
    expect(outcome).toBe('sent');
    /* The whole point: the bytes that LEAVE carry the account. Asserting on the
       stored payload instead would pass on a drain that changed nothing. */
    expect(sent[0].DebtorCode).toBe(AC_DEBTOR_CODE);
  });

  test('a payload that already names one is left exactly as it was stored', async () => {
    /* The backfill is a repair for old rows, not an override. A row composed
       after #2340 must go out byte-for-byte as it was composed. */
    const { sent } = await goSalesConversion({ DebtorCode: '300-C099' });
    expect(sent[0].DebtorCode).toBe('300-C099');
  });
});
});
