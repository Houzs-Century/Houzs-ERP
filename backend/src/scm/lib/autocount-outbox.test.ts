// The ERP -> AutoCount write-back outbox: what gets queued, what does not, and
// what the drain does with it.
//
// Two properties matter more than the rest and are pinned first:
//   • the toggle ships OFF, and OFF means nothing is queued at all;
//   • a failure to queue can never fail a user's save.
import { describe, expect, test, beforeEach, vi } from 'vitest';
import {
  enqueueAcOp,
  enqueueSoCreate,
  enqueuePoCreate,
  enqueueConvert,
  recordConvertSkipped,
  enqueueCancel,
  enqueueEdit,
  dispatchOne,
  MAX_ATTEMPTS,
  type AcOutboxRow,
} from './autocount-outbox';
import { resetWritebackFlagCache } from './autocount-writeback-flag';

type Row = Record<string, any>;

/* PostgREST stand-in over in-memory tables. Supports the shapes this module
   uses: select/eq/neq/in/lt/order/limit/maybeSingle, insert and update.
   `missing` names columns the table does NOT have: asking for one fails the
   whole query with 42703 and a null body, exactly as PostgREST does — the only
   way a test can catch a read that quietly becomes "this document has no
   lines". */
function fakeSb(tables: Record<string, Row[]>, missing: Record<string, string[]> = {}) {
  const from = (table: string) => {
    tables[table] ??= [];
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | null = null;
    let pendingInsert: Row | null = null;
    let pendingUpdate: Row | null = null;
    let columnError: { code: string; message: string } | null = null;
    const rows = () => {
      const rs = tables[table].filter((r) => filters.every((f) => f(r)));
      return limitN == null ? rs : rs.slice(0, limitN);
    };
    const settle = () => {
      if (columnError) return { data: null, error: columnError };
      if (pendingInsert) {
        tables[table].push({ id: `row-${tables[table].length + 1}`, ...pendingInsert });
        return { data: null, error: null };
      }
      if (pendingUpdate) {
        for (const r of rows()) Object.assign(r, pendingUpdate);
        return { data: null, error: null };
      }
      return { data: rows(), error: null };
    };
    const builder: any = {
      select(cols?: string) {
        const gone = (missing[table] ?? []).filter((c) => (cols ?? '').split(',').map((x) => x.trim()).includes(c));
        if (gone.length) columnError = { code: '42703', message: `column ${table}.${gone[0]} does not exist` };
        return builder;
      },
      insert(payload: Row) { pendingInsert = payload; return builder; },
      update(patch: Row) { pendingUpdate = patch; return builder; },
      eq(col: string, val: unknown) { filters.push((r) => String(r[col]) === String(val)); return builder; },
      neq(col: string, val: unknown) { filters.push((r) => String(r[col]) !== String(val)); return builder; },
      in(col: string, vals: unknown[]) { filters.push((r) => vals.map(String).includes(String(r[col]))); return builder; },
      lt(col: string, val: unknown) { filters.push((r) => Number(r[col] ?? 0) < Number(val)); return builder; },
      order() { return builder; },
      limit(n: number) { limitN = n; return builder; },
      maybeSingle: async () => (columnError ? { data: null, error: columnError } : { data: rows()[0] ?? null, error: null }),
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(settle()).then(resolve); },
    };
    return builder;
  };
  return { from, tables } as never as { from: (t: string) => any; tables: Record<string, Row[]> };
}

/** app_config seeded to whatever the test needs the toggle to say. */
const withFlag = (value: string | null, extra: Record<string, Row[]> = {}, missing: Record<string, string[]> = {}) =>
  fakeSb({
    app_config: value == null ? [] : [{ key: 'scm.autocount_writeback', value }],
    autocount_outbox: [],
    ...extra,
  }, missing);

const outbox = (sb: { tables: Record<string, Row[]> }) => sb.tables.autocount_outbox ?? [];

beforeEach(() => resetWritebackFlagCache());

describe('the runtime toggle', () => {
  test('OFF — the state it ships in — queues nothing at all', async () => {
    const sb = withFlag('off');
    expect(await enqueueAcOp(sb as never, {
      companyId: 1, op: 'create_so', docType: 'SO', docNo: 'HC-SO-1', payload: { body: {} },
    })).toBe(false);
    expect(outbox(sb)).toHaveLength(0);
  });

  test('an ABSENT config row is off, not on', async () => {
    const sb = withFlag(null);
    expect(await enqueueAcOp(sb as never, {
      companyId: 1, op: 'create_so', docType: 'SO', docNo: 'HC-SO-1', payload: { body: {} },
    })).toBe(false);
    expect(outbox(sb)).toHaveLength(0);
  });

  test("is per company: '1' enables Houzs and leaves 2990 alone", async () => {
    const sb = withFlag('1');
    await enqueueAcOp(sb as never, {
      companyId: 1, op: 'create_so', docType: 'SO', docNo: 'HC-SO-1', payload: { body: {} },
    });
    resetWritebackFlagCache();
    await enqueueAcOp(sb as never, {
      companyId: 2, op: 'create_so', docType: 'SO', docNo: '2990-SO-1', payload: { body: {} },
    });
    expect(outbox(sb).map((r) => r.doc_no)).toEqual(['HC-SO-1']);
  });

  test("'all' enables every company", async () => {
    const sb = withFlag('all');
    expect(await enqueueAcOp(sb as never, {
      companyId: 2, op: 'create_so', docType: 'SO', docNo: '2990-SO-1', payload: { body: {} },
    })).toBe(true);
  });

  test('a save is never failed by the outbox: a dead DB returns false, it does not throw', async () => {
    const dead = {
      from() { throw new Error('connection refused'); },
    } as never;
    await expect(enqueueAcOp(dead, {
      companyId: 1, op: 'create_so', docType: 'SO', docNo: 'HC-SO-1', payload: { body: {} },
    })).resolves.toBe(false);
  });
});

describe('the six flows each queue their operation', () => {
  const so = {
    doc_no: 'HC-SO-9', so_date: '2026-08-10', debtor_name: 'ACME', agent: 'KRIS',
    sales_location: 'KL WAREHOUSE', branding: 'AKEMI', venue: 'SUTERA MALL',
    address1: 'A1', address2: null, address3: null, address4: null,
    phone: '012', ref: 'R', po_doc_no: null, linked_ac_docno: null,
  };
  const soItem = { doc_no: 'HC-SO-9', item_code: 'SKU-1', description: 'Mattress', qty: 2, unit_price_centi: 12345 };
  /* scm.purchase_orders as it ACTUALLY is: supplier_id, not a creditor code or
     name, and no agent or ref at all. The creditor is one join away. */
  const po = {
    id: 'po-1', po_number: 'HC-PO-9', po_date: '2026-08-10',
    supplier_id: 'sup-1', notes: 'a note', linked_ac_docno: null,
  };
  const supplier = { id: 'sup-1', code: '400-H004', name: 'Supplier' };

  test('1. SO create', async () => {
    const sb = withFlag('1', { mfg_sales_orders: [{ ...so }], mfg_sales_order_items: [{ ...soItem }] });
    expect(await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-9' })).toBe(true);
    const [row] = outbox(sb);
    expect(row.op).toBe('create_so');
    expect(row.doc_type).toBe('SO');
    expect(row.dedupe_key).toBe('create_so:HC-SO-9');
    expect(row.payload.body.DocNo).toBe('HC-SO-9');
    expect(row.payload.body.Agent).toBe('KRIS');
    expect(row.payload.body.SalesLocation).toBe('KL');
    expect(row.payload.body.UDF).toEqual({ BRANDING: 'AKEMI', VENUE: 'SUTERA MALL SOLO' });
    expect(row.payload.body.Details[0].UnitPrice).toBe(123.45);
    expect(row.payload.writeback).toEqual({ table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' });
  });

  test('a cutover-imported SO is never created again', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...so, linked_ac_docno: 'SO-000021' }],
      mfg_sales_order_items: [{ ...soItem }],
    });
    expect(await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-9' })).toBe(false);
    expect(outbox(sb)).toHaveLength(0);
  });

  test('2. PO create — the creditor comes from scm.suppliers, through supplier_id', async () => {
    const sb = withFlag('1', {
      purchase_orders: [{ ...po }],
      suppliers: [{ ...supplier }],
      purchase_order_items: [{ purchase_order_id: 'po-1', material_code: 'SKU-1', description: 'D', qty: 3, unit_price_centi: 5000 }],
    }, {
      /* The four columns the composer used to ask purchase_orders for and that
         it has never had. Naming them here is what makes this test fail if one
         comes back: PostgREST answers 42703 and the whole PO flow goes silent. */
      purchase_orders: ['creditor_code', 'creditor_name', 'agent', 'ref'],
    });
    expect(await enqueuePoCreate(sb as never, { companyId: 1, poId: 'po-1' })).toBe(true);
    const [row] = outbox(sb);
    expect(row.op).toBe('create_po');
    expect(row.doc_no).toBe('HC-PO-9');
    /* AcSyncService assigns CreditorCode unconditionally (AcSyncService.cs:199)
       and a purchase order with a blank creditor cannot be saved. */
    expect(row.payload.body.CreditorCode).toBe('400-H004');
    expect(row.payload.body.CreditorName).toBe('Supplier');
    expect(row.payload.body.Description).toBe('a note');
    expect(row.payload.body.Details).toHaveLength(1);
    expect(row.payload.body.Details[0].Qty).toBe(3);
    expect(row.payload.body.Details[0].UnitPrice).toBe(50);
  });

  test('a PO edit reaches AutoCount too, and leaves the book\'s own Ref alone', async () => {
    const sb = withFlag('1', {
      purchase_orders: [{ ...po, linked_ac_docno: 'PO-000042' }],
      suppliers: [{ ...supplier }],
      purchase_order_items: [{ purchase_order_id: 'po-1', material_code: 'SKU-1', description: 'D', qty: 3, unit_price_centi: 5000, linked_ac_dtlkey: 7001 }],
    }, { purchase_orders: ['creditor_code', 'creditor_name', 'agent', 'ref'] });
    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'PO', docId: 'po-1' })).toBe(true);
    const [row] = outbox(sb);
    expect(row.op).toBe('edit');
    expect(row.doc_no).toBe('HC-PO-9');
    expect(row.payload.body.Header).toEqual({ CreditorName: 'Supplier', Description: 'a note' });
    /* /edit applies only the header keys it is GIVEN (AcSyncService.cs:369), so
       an absent Ref leaves AutoCount's alone; a null Ref would blank it. */
    expect(Object.keys(row.payload.body.Header)).not.toContain('Ref');
    expect(row.payload.body.Lines).toHaveLength(1);
  });

  test.each([
    ['3. SO -> DO', 'so_to_do', 'DO', 'mfg_sales_orders', 'delivery_orders'],
    ['4. PO -> GR', 'po_to_gr', 'GR', 'purchase_orders', 'grns'],
    ['5. DO -> Invoice', 'do_to_iv', 'IV', 'delivery_orders', 'sales_invoices'],
    ['6. GRN -> Purchase Invoice', 'gr_to_pi', 'PI', 'grns', 'purchase_invoices'],
  ])('%s', async (_name, op, docType, fromTable, toTable) => {
    const sb = withFlag('1');
    expect(await enqueueConvert(sb as never, {
      companyId: 1,
      op: op as never,
      from: { table: fromTable as never, keyCol: 'id', key: 'src-1' },
      to: { table: toTable as never, keyCol: 'id', key: 'dst-1' },
      docType: docType as never,
      docNo: 'DOC-1',
      docId: 'dst-1',
    })).toBe(true);
    const [row] = outbox(sb);
    expect(row.op).toBe(op);
    expect(row.doc_type).toBe(docType);
    /* No DtlKeys: AutoCount's own book decides which lines are still
       outstanding — see the note in enqueueConvert. */
    expect(row.payload.body.DtlKeys).toBeUndefined();
    expect(row.payload.fromDoc.table).toBe(fromTable);
    expect(row.payload.writeback.table).toBe(toTable);
  });

  /* A read that FAILS is not a document with nothing on it. PostgREST answers a
     column it does not have with 42703 and a NULL body; `data ?? []` then turns
     that failure into an empty line list and the write-back pushes a header with
     no Details into a live account book. Nothing on the AutoCount side can tell
     that apart from an order the operator really did leave empty. */
  describe('a failed read is never an empty document', () => {
    const noDtlKey = { mfg_sales_order_items: ['linked_ac_dtlkey'], purchase_order_items: ['linked_ac_dtlkey'] };

    test('SO create: the line read fails -> nothing is queued, and it is written down', async () => {
      const sb = withFlag('1', {
        mfg_sales_orders: [{ ...so }], mfg_sales_order_items: [{ ...soItem }],
      }, noDtlKey);
      expect(await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-9' })).toBe(false);
      const rows = outbox(sb);
      expect(rows.filter((r) => r.status === 'pending')).toHaveLength(0);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('skipped');
      expect(rows[0].last_error).toContain('42703');
      // The point of the whole exercise: no document with an empty line list.
      expect(rows.some((r) => Array.isArray(r.payload?.body?.Details))).toBe(false);
    });

    test('SO edit: the same, so an edit cannot blank an order either', async () => {
      const sb = withFlag('1', {
        mfg_sales_orders: [{ ...so, linked_ac_docno: 'SO-000021' }],
        mfg_sales_order_items: [{ ...soItem }],
      }, noDtlKey);
      expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: 'HC-SO-9' })).toBe(false);
      const rows = outbox(sb);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('skipped');
      expect(rows.some((r) => Array.isArray(r.payload?.body?.Lines))).toBe(false);
    });

    test('PO create: a header read that fails queues nothing', async () => {
      const sb = withFlag('1', {
        purchase_orders: [{ ...po }], suppliers: [{ ...supplier }],
        purchase_order_items: [{ purchase_order_id: 'po-1', material_code: 'SKU-1', qty: 1, unit_price_centi: 1 }],
      }, { purchase_orders: ['po_number'] });
      expect(await enqueuePoCreate(sb as never, { companyId: 1, poId: 'po-1' })).toBe(false);
      const rows = outbox(sb);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('skipped');
      expect(rows[0].last_error).toContain('42703');
    });

    test('a read that finds NOTHING is still just nothing — no note, no row', async () => {
      const sb = withFlag('1', { mfg_sales_orders: [], mfg_sales_order_items: [] });
      expect(await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-404' })).toBe(false);
      expect(outbox(sb)).toHaveLength(0);
    });
  });

  test('a merged conversion is written down as skipped, never silently dropped', async () => {
    const sb = withFlag('1');
    await recordConvertSkipped(sb as never, {
      companyId: 1, op: 'so_to_do', docType: 'DO', docNo: 'HC-DO-5', docId: 'do-5',
      reason: 'merged from 2 Sales Orders',
    });
    const [row] = outbox(sb);
    expect(row.status).toBe('skipped');
    expect(row.last_error).toContain('merged from 2 Sales Orders');
  });
});

describe('cancel and edit against a document still sitting in the outbox', () => {
  const so = {
    doc_no: 'HC-SO-9', so_date: null, debtor_name: 'ACME', agent: null, sales_location: null,
    branding: null, venue: null, address1: null, address2: null, address3: null, address4: null,
    phone: null, ref: null, po_doc_no: null, linked_ac_docno: null,
  };

  test('cancelling before the create was sent skips the create instead of creating then cancelling', async () => {
    const sb = withFlag('1', { mfg_sales_orders: [{ ...so }], mfg_sales_order_items: [] });
    await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-9' });
    resetWritebackFlagCache();

    expect(await enqueueCancel(sb as never, {
      companyId: 1, docType: 'SO', docNo: 'HC-SO-9',
      self: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
    })).toBe(false);

    const rows = outbox(sb);
    expect(rows).toHaveLength(1);
    expect(rows[0].op).toBe('create_so');
    expect(rows[0].status).toBe('skipped');
  });

  test('cancelling a DO whose SO->DO conversion is still queued skips the conversion', async () => {
    /* A DO has no create of its own — the conversion is what would bring it
       into AutoCount, so that is the row a cancel has to catch. */
    const sb = withFlag('1');
    await enqueueConvert(sb as never, {
      companyId: 1,
      op: 'so_to_do',
      from: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
      to: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
      docType: 'DO',
      docNo: 'HC-DO-1',
      docId: 'do-1',
    });
    resetWritebackFlagCache();

    expect(await enqueueCancel(sb as never, {
      companyId: 1, docType: 'DO', docNo: 'HC-DO-1', docId: 'do-1',
      self: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
    })).toBe(false);

    const rows = outbox(sb);
    expect(rows).toHaveLength(1);
    expect(rows[0].op).toBe('so_to_do');
    expect(rows[0].status).toBe('skipped');
  });

  test('cancelling a document AutoCount already has queues a cancel', async () => {
    const sb = withFlag('1', { mfg_sales_orders: [{ ...so, linked_ac_docno: 'SO-000021' }] });
    expect(await enqueueCancel(sb as never, {
      companyId: 1, docType: 'SO', docNo: 'HC-SO-9',
      self: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
    })).toBe(true);
    const [row] = outbox(sb);
    expect(row.op).toBe('cancel');
    expect(row.payload.body.DocType).toBe('SO');
    expect(row.payload.selfDoc.key).toBe('HC-SO-9');
  });

  test('editing before the create was sent REPLACES the pending create payload', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...so }],
      mfg_sales_order_items: [{ doc_no: 'HC-SO-9', item_code: 'SKU-1', description: 'before', qty: 1, unit_price_centi: 100 }],
    });
    await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-9' });
    expect(outbox(sb)[0].payload.body.Details[0].Description).toBe('before');

    sb.tables.mfg_sales_order_items[0].description = 'after';
    sb.tables.mfg_sales_order_items[0].qty = 4;
    resetWritebackFlagCache();
    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: 'HC-SO-9' })).toBe(true);

    const rows = outbox(sb);
    /* One row, still the create — an edit queued BEHIND a stale create would
       push the pre-edit order into the live book and then correct it. */
    expect(rows).toHaveLength(1);
    expect(rows[0].op).toBe('create_so');
    expect(rows[0].payload.body.Details[0].Description).toBe('after');
    expect(rows[0].payload.body.Details[0].Qty).toBe(4);
  });

  test('editing a document AutoCount already has queues an edit that addresses its lines by DtlKey', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...so, linked_ac_docno: 'SO-000021' }],
      mfg_sales_order_items: [
        { doc_no: 'HC-SO-9', item_code: 'SKU-1', description: 'known line', qty: 1, unit_price_centi: 100, linked_ac_dtlkey: 4242 },
        { doc_no: 'HC-SO-9', item_code: 'SKU-2', description: 'other line', qty: 1, unit_price_centi: 200, linked_ac_dtlkey: 4243 },
      ],
    });
    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: 'HC-SO-9' })).toBe(true);
    const [row] = outbox(sb);
    expect(row.op).toBe('edit');
    expect(row.payload.body.Lines[0].DtlKey).toBe(4242);
    expect(row.payload.body.Lines[1].DtlKey).toBe(4243);
    /* Successive edits are separate intents and must both be applied, so an
       edit never carries a dedupe key. */
    expect(row.dedupe_key).toBeNull();
  });

  /* The guard, end to end through the enqueue path. A document AutoCount has,
     holding a line with no DtlKey, must produce NO pending edit — and must not
     vanish either: a refusal nobody can see reads exactly like a write-back
     that quietly stopped working. */
  test('an edit whose line has no DtlKey is REFUSED and recorded as skipped, not queued', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...so, linked_ac_docno: 'SO-000021' }],
      mfg_sales_order_items: [
        { doc_no: 'HC-SO-9', item_code: 'SKU-1', description: 'keyed', qty: 1, unit_price_centi: 100, linked_ac_dtlkey: 4242 },
        { doc_no: 'HC-SO-9', item_code: 'SKU-2', description: 'keyless', qty: 1, unit_price_centi: 200, linked_ac_dtlkey: null },
      ],
    });
    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: 'HC-SO-9' })).toBe(false);

    const rows = outbox(sb);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('skipped');
    expect(rows[0].op).toBe('edit');
    expect(rows[0].last_error).toContain('refused, nothing sent');
    expect(rows[0].last_error).toContain('SKU-2');
    /* Nothing pending means nothing will ever be POSTed for this save. */
    expect(rows.filter((r: Row) => r.status === 'pending')).toHaveLength(0);
  });

  test('editing a document AutoCount never received queues nothing', async () => {
    const sb = withFlag('1', { mfg_sales_orders: [{ ...so }], mfg_sales_order_items: [] });
    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: 'HC-SO-9' })).toBe(false);
    expect(outbox(sb)).toHaveLength(0);
  });
});

describe('the drain', () => {
  const env = { AC_SYNC_URL: 'http://ac.local:8900', AC_SYNC_KEY: 'k' } as never;
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

    expect(await dispatchOne(env, sb as never, row(), fetchImpl)).toBe('sent');
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

    expect(await dispatchOne(env, sb as never, lineRow(), fetchImpl)).toBe('sent');
    expect(sb.tables.mfg_sales_order_items[0].linked_ac_dtlkey).toBe(5001);
    expect(sb.tables.mfg_sales_order_items[1].linked_ac_dtlkey).toBe(5002);
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

    expect(await dispatchOne(env, sb as never, lineRow(), fetchImpl)).toBe('sent');
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

    expect(await dispatchOne(env, sb as never, lineRow(), fetchImpl)).toBe('sent');
    expect(sb.tables.mfg_sales_order_items[0].linked_ac_dtlkey).toBeNull();
  });

  /* An AcSyncService built before 2026-08-11 returns no `lines` at all, and the
     new one degrades to an empty array rather than losing the DocNo when its
     own read-back fails. Neither is a failure of the create. */
  test('a service that returns no lines still counts as sent', async () => {
    const sb = withFlag('1', twoLines());
    const fetchImpl = vi.fn(async () => jsonRes(200, { ok: true, docNo: 'SO-000123' })) as never;

    expect(await dispatchOne(env, sb as never, lineRow(), fetchImpl)).toBe('sent');
    expect(outbox(sb)[0].status).toBe('sent');
    expect(sb.tables.mfg_sales_orders[0].linked_ac_docno).toBe('SO-000123');
    expect(sb.tables.mfg_sales_order_items[0].linked_ac_dtlkey).toBeNull();
  });

  test('an unreachable AutoCount host is retried, not lost', async () => {
    const sb = withFlag('1', { autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }] });
    const fetchImpl = vi.fn(async () => { throw new Error('tunnel down'); }) as never;

    expect(await dispatchOne(env, sb as never, row(), fetchImpl)).toBe('retry');
    const after = outbox(sb)[0];
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(1);
    expect(after.last_error).toContain('tunnel down');
  });

  test('the last allowed attempt gives up, and says how many it took', async () => {
    const sb = withFlag('1', { autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: MAX_ATTEMPTS - 1 }] });
    const fetchImpl = vi.fn(async () => { throw new Error('tunnel down'); }) as never;

    expect(await dispatchOne(env, sb as never, row({ attempts: MAX_ATTEMPTS - 1 }), fetchImpl)).toBe('failed');
    const after = outbox(sb)[0];
    expect(after.status).toBe('failed');
    expect(after.attempts).toBe(MAX_ATTEMPTS);
    expect(after.last_error).toContain(`Gave up after ${MAX_ATTEMPTS} attempts`);
  });

  test("AutoCount's own refusal is kept verbatim and not retried into the ground", async () => {
    const sb = withFlag('1', { autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }] });
    const fetchImpl = vi.fn(async () => jsonRes(400, { ok: false, error: 'DocNo already exists' })) as never;

    expect(await dispatchOne(env, sb as never, row(), fetchImpl)).toBe('failed');
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

    const outcome = await dispatchOne(env, sb as never, row({
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

    expect(await dispatchOne(env, sb as never, row({
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
});
