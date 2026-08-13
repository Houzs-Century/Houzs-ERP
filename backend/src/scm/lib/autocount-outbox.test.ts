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
  mastersOf,
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
    let wantCount = false;
    const rows = () => {
      const rs = tables[table].filter((r) => filters.every((f) => f(r)));
      return limitN == null ? rs : rs.slice(0, limitN);
    };
    const settle = () => {
      if (columnError) return { data: null, error: columnError };
      /* head:true asks for the COUNT and no rows. conversionIsPartial reads it
         to decide whether a transfer leaves any of the parent's lines behind,
         and a fake that answered `undefined` would make every test take the
         refusal branch for the wrong reason. */
      if (wantCount) return { data: null, count: rows().length, error: null };
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
      select(cols?: string, opts?: { count?: string; head?: boolean }) {
        const gone = (missing[table] ?? []).filter((c) => (cols ?? '').split(',').map((x) => x.trim()).includes(c));
        if (gone.length) columnError = { code: '42703', message: `column ${table}.${gone[0]} does not exist` };
        if (opts?.count) wantCount = true;
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

/* REAL cutover codes, not invented ones. Since D10 the composer resolves every
   ERP code against autocount-erp-mapping-1561.csv and REFUSES what it cannot
   find, so a fixture SKU that the account book has never heard of no longer
   tests the flow — it tests the refusal. These four are rows of the real map:
   the ERP code on the left is what scm holds, the AC code on the right is what
   the licensed book calls it, and both map 1:1 so no supplier is needed. */
const ERP_A = 'AKEMI APEX MATT (SP)';
const AC_A = 'AK-APEX MATT (SP)';
const ERP_B = 'AKEMI ARISTOI MATT (SP)';
const AC_B = 'AK-ARISTOI MATT (SP)';

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

  test('a value nobody can parse leaves the push OFF, it does not turn it on', async () => {
    /* THE SHARED-PARSER TRAP. This flag reuses parseFreezeValue so the two
       switches speak one dialect — but the write FREEZE fails closed by
       resolving an unreadable value to 'all', and inheriting that here would
       mean a typo in this row starts pushing every company's documents into a
       LIVE licensed AutoCount book. Opposite safe direction, same parser:
       readWritebackScope maps `malformed` to 'off'. */
    for (const raw of ['yes', 'houzs', 'on', '1;2', 'company 1']) {
      resetWritebackFlagCache();
      const sb = withFlag(raw);
      expect(await enqueueAcOp(sb as never, {
        companyId: 1, op: 'create_so', docType: 'SO', docNo: 'HC-SO-1', payload: { body: {} },
      }), raw).toBe(false);
      expect(outbox(sb), raw).toHaveLength(0);
    }
  });

  test('a freeze value pasted into this row turns the push OFF, not on', async () => {
    /* 'scm.write_freeze' and 'scm.autocount_writeback' are adjacent keys in the
       same table sharing one grammar, so pasting one row's value into the other
       is a live operator error, not a hypothetical. '1 - scm.sales.orders' is a
       FREEZE instruction; this switch has no per-module meaning, so rather than
       reading it as "company 1 on" it declines to act on it at all. */
    for (const raw of ['1 - scm.sales.orders', 'all - scm.procurement.po', 'true-ish']) {
      resetWritebackFlagCache();
      const sb = withFlag(raw);
      expect(await enqueueAcOp(sb as never, {
        companyId: 1, op: 'create_so', docType: 'SO', docNo: 'HC-SO-1', payload: { body: {} },
      }), raw).toBe(false);
      expect(outbox(sb), raw).toHaveLength(0);
    }
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
  const soItem = { doc_no: 'HC-SO-9', item_code: ERP_A, description: 'Mattress', qty: 2, unit_price_centi: 12345 };
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
      purchase_order_items: [{ purchase_order_id: 'po-1', material_code: ERP_A, description: 'D', qty: 3, unit_price_centi: 5000, warehouse_id: 'wh-1' }],
      warehouses: [{ id: 'wh-1', code: 'KL', name: 'KL WAREHOUSE' }],
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
      purchase_order_items: [{ purchase_order_id: 'po-1', material_code: ERP_A, description: 'D', qty: 3, unit_price_centi: 5000, linked_ac_dtlkey: 7001 }],
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
        purchase_order_items: [{ purchase_order_id: 'po-1', material_code: ERP_A, qty: 1, unit_price_centi: 1 }],
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
    doc_no: 'HC-SO-9', so_date: null, debtor_name: 'ACME', agent: null, sales_location: 'KL',
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
      mfg_sales_order_items: [{ doc_no: 'HC-SO-9', item_code: ERP_A, description: 'before', qty: 1, unit_price_centi: 100 }],
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
        { doc_no: 'HC-SO-9', item_code: ERP_A, description: 'known line', qty: 1, unit_price_centi: 100, linked_ac_dtlkey: 4242 },
        { doc_no: 'HC-SO-9', item_code: ERP_B, description: 'other line', qty: 1, unit_price_centi: 200, linked_ac_dtlkey: 4243 },
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
        { doc_no: 'HC-SO-9', item_code: ERP_A, description: 'keyed', qty: 1, unit_price_centi: 100, linked_ac_dtlkey: 4242 },
        { doc_no: 'HC-SO-9', item_code: ERP_B, description: 'keyless', qty: 1, unit_price_centi: 200, linked_ac_dtlkey: null },
      ],
    });
    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: 'HC-SO-9' })).toBe(false);

    const rows = outbox(sb);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('skipped');
    expect(rows[0].op).toBe('edit');
    expect(rows[0].last_error).toContain('refused, nothing sent');
    /* Named by its KeylessLineError, not by an ItemCode refusal that happens to
       quote the same row. Both codes resolve cleanly, so the ONLY thing that can
       stop this edit is the missing DtlKey — and the message says so in
       AutoCount's own vocabulary, which is what the operator has to look up. */
    expect(rows[0].last_error).toContain('KeylessLineError');
    expect(rows[0].last_error).toContain('DtlKey');
    expect(rows[0].last_error).toContain(AC_B);
    expect(rows[0].last_error).not.toContain('no single AutoCount ItemCode');
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

/* ── LINE REMOVAL IS A RETIREMENT ────────────────────────────────────────────
   /edit applies only the lines it is GIVEN, so a line the ERP removed and did
   not mention stays live, outstanding and transferable in the account book. */
describe('a removed line is retired in AutoCount, never just left out', () => {
  const soHeader = {
    doc_no: 'HC-SO-9', so_date: null, debtor_name: 'ACME', agent: null, sales_location: 'KL',
    branding: null, venue: null, address1: null, address2: null, address3: null, address4: null,
    phone: null, ref: null, po_doc_no: null, linked_ac_docno: 'SO-000021',
  };
  const keyed = (over: Record<string, unknown> = {}) => ({
    id: 'so-item-1', doc_no: 'HC-SO-9', item_code: 'Y04-(K)', description: 'Mattress',
    qty: 2, unit_price_centi: 100, linked_ac_dtlkey: 7001, cancelled: false, ...over,
  });

  test('a HARD-DELETED line is named on the next edit with Retire: true', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...soHeader }],
      mfg_sales_order_items: [keyed()],
    });
    expect(await enqueueEdit(sb as never, {
      companyId: 1,
      docType: 'SO',
      docNo: 'HC-SO-9',
      retire: [{ DtlKey: 7002, ItemCode: 'AERO-Y09 (K)', Desc2: 'Col: Grey' }],
    })).toBe(true);
    const [row] = outbox(sb);
    expect(row.payload.body.Lines).toHaveLength(2);
    expect(row.payload.body.Lines[0]).toMatchObject({ DtlKey: 7001, Qty: 2 });
    expect(row.payload.body.Lines[1]).toEqual({
      DtlKey: 7002, ItemCode: 'AERO-Y09 (K)', Desc2: 'Col: Grey', Retire: true,
    });
  });

  test('a RETAINED cancelled line is retired, not sent as a live line', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...soHeader }],
      mfg_sales_order_items: [
        keyed(),
        keyed({ id: 'so-item-2', item_code: 'Y09-(K)', linked_ac_dtlkey: 7002, cancelled: true }),
      ],
    });
    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: 'HC-SO-9' })).toBe(true);
    const [row] = outbox(sb);
    const lines = row.payload.body.Lines as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(2);
    const retired = lines.find((l) => l.DtlKey === 7002);
    expect(retired?.Retire).toBe(true);
    /* No quantity on a retired line: AcSyncService zeroes it, and sending the
       ERP number would be inert today and wrong the day it stops being. */
    expect(retired?.Qty).toBeUndefined();
  });

  test('a cancelled line with NO key is refused — a retirement we cannot name is not one we may drop', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...soHeader }],
      mfg_sales_order_items: [
        keyed(),
        keyed({ id: 'so-item-2', item_code: 'Y09-(K)', linked_ac_dtlkey: null, cancelled: true }),
      ],
    });
    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: 'HC-SO-9' })).toBe(false);
    const [row] = outbox(sb);
    expect(row.status).toBe('skipped');
    expect(row.last_error).toContain('cancelled');
    expect(row.last_error).toContain('cannot be retired');
  });

  test('a re-added line that inherited the key is edited, not retired out from under itself', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...soHeader }],
      mfg_sales_order_items: [keyed()],
    });
    expect(await enqueueEdit(sb as never, {
      companyId: 1, docType: 'SO', docNo: 'HC-SO-9',
      retire: [{ DtlKey: 7001, ItemCode: 'AERO-Y04 (K)' }],
    })).toBe(true);
    const [row] = outbox(sb);
    expect(row.payload.body.Lines).toHaveLength(1);
    expect(row.payload.body.Lines[0].Retire).toBeUndefined();
  });

  test('a CREATE never carries a cancelled line — AutoCount holds nothing to retire yet', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...soHeader, linked_ac_docno: null }],
      mfg_sales_order_items: [
        keyed({ linked_ac_dtlkey: null }),
        keyed({ id: 'so-item-2', item_code: 'Y09-(K)', linked_ac_dtlkey: null, cancelled: true }),
      ],
    });
    expect(await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-9' })).toBe(true);
    const [row] = outbox(sb);
    expect(row.payload.body.Details).toHaveLength(1);
    expect(row.payload.body.Details[0].ItemCode).toBe('AERO-Y04 (K)');
  });
});

/* A document naming a master the account book does not have does not fail
   politely - it fails on a FOREIGN KEY and takes the whole document with it.
   The live book proved the shape on 2026-08-11 by answering FK_SODTL_Location
   to a create whose lines carried no stock location. */
describe('the masters a document names are opened BEFORE the document is sent', () => {
  const env = { AC_SYNC_URL: 'http://ac.local:8900', AC_SYNC_KEY: 'k' } as never;
  const jsonRes = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const createRow = (body: Record<string, unknown>): AcOutboxRow => ({
    id: 'ob-1', company_id: 1, op: 'create_so', doc_type: 'SO', doc_no: 'HC-SO-9',
    doc_id: null, payload: { body }, status: 'pending', attempts: 0, dedupe_key: null,
  });

  test('mastersOf reads the payload that is about to be sent, and dedupes it', () => {
    const m = mastersOf({
      Agent: 'WW',
      Details: [
        { ItemCode: 'A', Description: 'first' },
        { ItemCode: 'A', Description: 'same code again' },
        { ItemCode: 'B', UOM: 'SET' },
      ],
    }) as { Items: Array<Record<string, unknown>>; Agents: Array<Record<string, unknown>> };
    expect(m.Items.map((i) => i.ItemCode)).toEqual(['A', 'B']);
    expect(m.Items[0].Description).toBe('first');
    expect(m.Items[1].UOM).toBe('SET');
    expect(m.Agents).toEqual([{ Agent: 'WW' }]);
  });

  test('a RETIRED line names nothing: it is addressed by a key AutoCount itself issued', () => {
    const m = mastersOf({ Lines: [{ DtlKey: 7001, ItemCode: 'GONE', Retire: true }] });
    expect(m).toBeNull();
  });

  test('the masters call happens FIRST, and the document goes second', async () => {
    const sb = withFlag('1', { autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }] });
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(String(url));
      return jsonRes(200, { ok: true, docNo: 'SO-000123' });
    }) as never;
    expect(await dispatchOne(env, sb as never, createRow({
      DocNo: 'HC-SO-9', Details: [{ ItemCode: 'NEW-SKU', Description: 'a new one' }],
    }), fetchImpl)).toBe('sent');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('/ensure-masters');
    expect(calls[1]).toContain('/create-so');
  });

  test('masters that cannot be opened stop the document — a half-created book is worse', async () => {
    const sb = withFlag('1', { autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }] });
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(String(url));
      return String(url).includes('/ensure-masters')
        ? jsonRes(200, { ok: false, error: '1 master(s) could not be opened' })
        : jsonRes(200, { ok: true, docNo: 'SO-000123' });
    }) as never;
    const outcome = await dispatchOne(env, sb as never, createRow({
      DocNo: 'HC-SO-9', Details: [{ ItemCode: 'NEW-SKU' }],
    }), fetchImpl);
    expect(outcome).not.toBe('sent');
    /* The create was never attempted. */
    expect(calls.filter((c) => c.includes('/create-so'))).toHaveLength(0);
    expect(outbox(sb)[0].last_error).toContain('masters not opened');
  });

  test('a conversion opens nothing — it transfers lines the book already holds', async () => {
    const sb = withFlag('1', { autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }] });
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(String(url));
      return jsonRes(200, { ok: true, docNo: 'DO-0001' });
    }) as never;
    await dispatchOne(env, sb as never, {
      ...createRow({ Details: [{ ItemCode: 'X' }] }), op: 'so_to_do', doc_type: 'DO',
    }, fetchImpl);
    expect(calls.filter((c) => c.includes('/ensure-masters'))).toHaveLength(0);
  });
});

/* D8: a create sent the salesperson, the sales location, the document date and
   the three UDFs; an edit sent none of them, so changing any one on a live
   order never reached AutoCount. The account book takes all of them on /edit -
   they are in AcSyncService.Edit's allow-list and it calls ApplyUdf - so this
   was the ERP declining to speak, not AutoCount refusing to listen. */
describe('an edit carries the fields a create carries', () => {
  const so = {
    doc_no: 'HC-SO-9', so_date: '2026-08-10', debtor_name: 'ACME', agent: 'KAR JIUN',
    sales_location: 'PETALING JAYA', branding: 'AKEMI', venue: 'KSL CITY MALL',
    address1: 'A1', address2: null, address3: null, address4: null,
    phone: '012', ref: 'R', po_doc_no: 'CUST-PO-7', linked_ac_docno: 'SO-000021',
  };
  const item = {
    doc_no: 'HC-SO-9', item_code: ERP_A, description: 'M', qty: 1,
    unit_price_centi: 100, linked_ac_dtlkey: 991,
  };

  test('the salesperson, the location and the date reach AutoCount, mapped', async () => {
    const sb = withFlag('1', { mfg_sales_orders: [{ ...so }], mfg_sales_order_items: [{ ...item }] });
    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: 'HC-SO-9' })).toBe(true);
    const h = outbox(sb)[0].payload.body.Header as Record<string, unknown>;
    expect(h.Agent).toBe('TAN KAR JIUN');
    expect(h.SalesLocation).toBe('KL');
    expect(h.DocDate).toBe('2026-08-10');
  });

  test('branding and venue ride in the NESTED UDF object, which is the only place the service reads them', async () => {
    const sb = withFlag('1', { mfg_sales_orders: [{ ...so }], mfg_sales_order_items: [{ ...item }] });
    await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: 'HC-SO-9' });
    const h = outbox(sb)[0].payload.body.Header as Record<string, Record<string, string>>;
    expect(h.UDF).toEqual({ BRANDING: 'AKEMI', VENUE: 'KSL CITY MALL JOHOR SOLO', ToPONo: 'CUST-PO-7' });
  });

  test('a field the ERP does not have is OMITTED, never sent as null that would blank the book', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...so, agent: null, sales_location: null, branding: null, venue: null, po_doc_no: null }],
      mfg_sales_order_items: [{ ...item }],
    });
    await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: 'HC-SO-9' });
    const h = outbox(sb)[0].payload.body.Header as Record<string, unknown>;
    expect(h).not.toHaveProperty('Agent');
    expect(h).not.toHaveProperty('SalesLocation');
    expect(h).not.toHaveProperty('UDF');
  });
});

/* Adding a line to a document AutoCount already has. A keyless line means two
   opposite things - just added, or never backfilled - and guessing "added"
   appends a SECOND COPY of a line the account book already holds, permanently
   on a purchase order. So the ERP is told, by the route that did the adding,
   and only believed when the rest of the document proves the backfill is
   complete. */
describe('a line the ERP just added is declared, never inferred', () => {
  const so = {
    doc_no: 'HC-SO-9', so_date: null, debtor_name: 'ACME', agent: null, sales_location: 'KL',
    branding: null, venue: null, address1: null, address2: null, address3: null, address4: null,
    phone: null, ref: null, po_doc_no: null, linked_ac_docno: 'SO-000021',
  };
  const keyed = { id: 'row-old', doc_no: 'HC-SO-9', item_code: ERP_A, description: 'M', qty: 1, unit_price_centi: 100, linked_ac_dtlkey: 991 };
  const fresh = { id: 'row-new', doc_no: 'HC-SO-9', item_code: ERP_B, description: 'added', qty: 1, unit_price_centi: 200, linked_ac_dtlkey: null };

  test('declared by the route, and every other line keyed: it goes as IsNewLine', async () => {
    const sb = withFlag('1', { mfg_sales_orders: [{ ...so }], mfg_sales_order_items: [{ ...keyed }, { ...fresh }] });
    expect(await enqueueEdit(sb as never, {
      companyId: 1, docType: 'SO', docNo: 'HC-SO-9', newLineIds: ['row-new'],
    })).toBe(true);
    const lines = outbox(sb)[0].payload.body.Lines as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.DtlKey === 991)?.IsNewLine).toBeUndefined();
    expect(lines.find((l) => l.ItemCode === AC_B)?.IsNewLine).toBe(true);
  });

  test('NOT declared: refused, exactly as before — this is the whole guard', async () => {
    const sb = withFlag('1', { mfg_sales_orders: [{ ...so }], mfg_sales_order_items: [{ ...keyed }, { ...fresh }] });
    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: 'HC-SO-9' })).toBe(false);
    expect(outbox(sb)[0].last_error).toContain('refused, nothing sent');
  });

  test('another line is ALSO keyless: the document is not backfilled, so the declaration is not believed', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...so }],
      mfg_sales_order_items: [{ ...keyed, linked_ac_dtlkey: null, id: 'row-legacy' }, { ...fresh }],
    });
    expect(await enqueueEdit(sb as never, {
      companyId: 1, docType: 'SO', docNo: 'HC-SO-9', newLineIds: ['row-new'],
    })).toBe(false);
    expect(outbox(sb)[0].last_error).toContain('refused, nothing sent');
  });
});

/* The ERP numbers its own documents, on every type. A create always sent its
   DocNo and AutoCount took it; a conversion sent none, so AutoCount
   auto-numbered the DO, the GRN, the invoice and the purchase invoice - four of
   the six types carrying a number nobody here would recognise. */
describe('every document the ERP creates carries the ERP number', () => {
  const env = { AC_SYNC_URL: 'http://ac.local:8900', AC_SYNC_KEY: 'k' } as never;

  test('a conversion sends the CHILD document number, not the parent', async () => {
    const sb = withFlag('1', {
      delivery_orders: [{ id: 'do-1', do_number: 'DO-2608-004', linked_ac_docno: null }],
      mfg_sales_orders: [{ doc_no: 'HC-SO-9', linked_ac_docno: 'SO-000021' }],
      delivery_order_items: [],
    });
    expect(await enqueueConvert(sb as never, {
      companyId: 1,
      op: 'so_to_do',
      from: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
      to: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
      docType: 'DO',
      docNo: 'DO-2608-004',
      docId: 'do-1',
    })).toBe(true);
    const body = outbox(sb)[0].payload.body as Record<string, unknown>;
    expect(body.DocNo).toBe('DO-2608-004');
    /* The PARENT travels separately and is resolved at drain — confusing the
       two would ask AutoCount to number the child after the sales order. */
    expect(body.FromDocNo).toBeUndefined();
    expect(outbox(sb)[0].payload.fromDoc).toBeTruthy();
  });

  test('a create still sends its own number, unchanged', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{
        doc_no: 'HC-SO-9', so_date: null, debtor_name: 'A', agent: null, sales_location: 'KL',
        branding: null, venue: null, address1: null, address2: null, address3: null,
        address4: null, phone: null, ref: null, po_doc_no: null, linked_ac_docno: null,
      }],
      mfg_sales_order_items: [{ id: 'i1', doc_no: 'HC-SO-9', item_code: ERP_A, description: 'M', qty: 1, unit_price_centi: 100 }],
    });
    expect(await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-9' })).toBe(true);
    expect((outbox(sb)[0].payload.body as Record<string, unknown>).DocNo).toBe('HC-SO-9');
  });
});

/* A PURCHASE agent is a different master from a sales one - a different table
   (dbo.PurchaseAgent) behind a different foreign key (FK_PO_PurchaseAgent).
   Opening OTHERS as a SALES agent does nothing for a purchase order naming it,
   and /create-po is refused with the whole document. Proved on the live book
   2026-08-12, after ensure-masters had already reported agent:OTHERS existing. */
describe('the agent a PO names goes to the PURCHASE agent master, not the sales one', () => {
  test('a purchase payload sends PurchaseAgents and no sales Agents', () => {
    const m = mastersOf({
      CreditorCode: '400-N002', Agent: 'OTHERS', Details: [{ ItemCode: 'A' }],
    }) as { Agents: unknown[]; PurchaseAgents: Array<Record<string, unknown>> };
    expect(m.PurchaseAgents).toEqual([{ PurchaseAgent: 'OTHERS' }]);
    expect(m.Agents).toEqual([]);
  });

  test('a sales payload still sends Agents and no PurchaseAgents', () => {
    const m = mastersOf({
      DebtorCode: '300-C002', Agent: 'OTHERS', Details: [{ ItemCode: 'A' }],
    }) as { Agents: Array<Record<string, unknown>>; PurchaseAgents: unknown[] };
    expect(m.Agents).toEqual([{ Agent: 'OTHERS' }]);
    expect(m.PurchaseAgents).toEqual([]);
  });

  test('an agent-less purchase payload invents neither', () => {
    const m = mastersOf({ CreditorCode: '400-N002', Details: [{ ItemCode: 'A' }] }) as {
      Agents: unknown[]; PurchaseAgents: unknown[];
    };
    expect(m.Agents).toEqual([]);
    expect(m.PurchaseAgents).toEqual([]);
  });
});

/* A purchase order NAMES a creditor, and CreatePo applies CreditorCode
   unconditionally - so a supplier the account book does not have fails the same
   foreign key a missing item does, and takes the whole PO with it. */
describe('a purchase order opens its supplier too', () => {
  test('mastersOf names the creditor a PO payload carries', () => {
    const m = mastersOf({
      CreditorCode: '400-N999', CreditorName: 'New Supplier Sdn Bhd',
      Details: [{ ItemCode: 'A' }],
    }) as { Creditors: Array<Record<string, unknown>> };
    expect(m.Creditors).toEqual([{ AccNo: '400-N999', CompanyName: 'New Supplier Sdn Bhd' }]);
  });

  test('no creditor on a sales order — an SO names none, and one must not be invented', () => {
    const m = mastersOf({ Details: [{ ItemCode: 'A' }] }) as { Creditors: unknown[] };
    expect(m.Creditors).toEqual([]);
  });

  test('a nameless creditor falls back to its code, never to an empty company name', () => {
    const m = mastersOf({ CreditorCode: '400-N999' }) as { Creditors: Array<Record<string, unknown>> };
    expect(m.Creditors[0].CompanyName).toBe('400-N999');
  });

  test('the DEBTOR is still deliberately absent — one fixed account, name overwritten', () => {
    const m = mastersOf({ DebtorCode: '300-C002', DebtorName: 'Whoever', Details: [{ ItemCode: 'A' }] });
    expect(m).not.toHaveProperty('Debtors');
  });
});

/* Owner 2026-08-11: "Branding 和 Venue 也是要跟着开，然后仓库 Location 也是要
   跟着开。最好全部都一起开". Everything a document names is opened. */
describe('a document opens every master it names — warehouse and dropdowns too', () => {
  test('the warehouse on the header AND on each line', () => {
    const m = mastersOf({
      SalesLocation: 'KL',
      Details: [{ ItemCode: 'A', Location: 'PG' }, { ItemCode: 'B', Location: 'KL' }],
    }) as { Locations: Array<Record<string, unknown>> };
    /* Deduped, and the header's counts too. */
    expect(m.Locations.map((l) => l.Location).sort()).toEqual(['KL', 'PG']);
  });

  test('a RETIRED line names no warehouse — it is leaving, not arriving', () => {
    const m = mastersOf({
      Details: [{ DtlKey: 1, ItemCode: 'A', Location: 'NOWHERE', Retire: true }],
    });
    expect(m).toBeNull();
  });

  test('branding and venue are taken from the UDF block actually being sent', () => {
    const m = mastersOf({
      Details: [{ ItemCode: 'A', Location: 'KL' }],
      UDF: { BRANDING: 'HOUZS', VENUE: 'SOME NEW MALL', ToPONo: 'CUST-1' },
    }) as { UdfOptions: Array<Record<string, string>> };
    expect(m.UdfOptions).toEqual([
      { List: 'BRANDING', Value: 'HOUZS' },
      { List: 'VENUE', Value: 'SOME NEW MALL' },
    ]);
    /* ToPONo is a free-text UDF, not a dropdown — it has no option list to open. */
    expect(m.UdfOptions.find((o) => o.List === 'ToPONo')).toBeUndefined();
  });

  test('no UDF block, no options — nothing is invented from an absent field', () => {
    const m = mastersOf({ Details: [{ ItemCode: 'A', Location: 'KL' }] }) as { UdfOptions: unknown[] };
    expect(m.UdfOptions).toEqual([]);
  });
});

/* Regression: HC-SO-2608-001, 2026-08-13. The first real sales order saved
   after the write-back was switched on was refused —

     refused, nothing sent (ItemCodeError): line 1 — ERP item code '9028-1S'
     maps to 2 AutoCount items and the document names no supplier to choose
     between them

   — and the documented remedy, a supplier SKU binding, could not be applied.
   bindingsFor was handed the RAW line codes ('9028-1A(LHF)', '9028-2A(RHF)')
   while resolveAcItemCode looked the binding up by the collapsed base code
   ('9028-1S'), so the map never contained the key that was asked for. Four
   sofa models in the cutover map are ambiguous this way (9028, 9058, 5152,
   5080); until this, every sales order containing one of them was refused
   with no possible fix. */
describe('a sofa resolves through the binding recorded for its model', () => {
  const sofaSo = {
    doc_no: 'HC-SO-SOFA', so_date: '2026-08-13', debtor_name: 'LIM', agent: null,
    sales_location: 'KL WAREHOUSE', branding: null, venue: null,
    address1: null, address2: null, address3: null, address4: null,
    phone: null, ref: null, po_doc_no: null, linked_ac_docno: null,
  };
  /* Two compartments of one build, exactly as the ERP stores them: the price
     sits on the first row and the same Desc2 on both, which is what lets D9
     fold them into a single line carrying '9028-1S'. */
  const compartments = ['1A(LHF)', '2A(RHF)'].map((comp, i) => ({
    doc_no: 'HC-SO-SOFA',
    item_code: `9028-${comp}`,
    item_group: 'sofa',
    description: `SOFA 9028 ${comp}`,
    description2: '1A(LHF) + 2A(RHF) (28")',
    qty: 1,
    unit_price_centi: i === 0 ? 399000 : 0,
    location: 'KL',
  }));

  test('without a binding it is still refused, and the reason names the base code', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...sofaSo }],
      mfg_sales_order_items: compartments.map((l) => ({ ...l })),
      supplier_material_bindings: [],
    });
    expect(await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-SOFA' })).toBe(false);
    const [row] = outbox(sb);
    expect(row.status).toBe('skipped');
    expect(String(row.last_error)).toContain('ItemCodeError');
    expect(String(row.last_error)).toContain('9028-1S');
  });

  test('a binding on the MODEL BASE CODE is found and the document sends', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...sofaSo }],
      mfg_sales_order_items: compartments.map((l) => ({ ...l })),
      /* The row an operator can actually create: the ERP model code on the
         left, the account book's item on the right. Before the fix this row
         existed and changed nothing, because the query never asked for it. */
      supplier_material_bindings: [{
        company_id: 1, material_code: '9028-1S', material_kind: 'mfg_product',
        supplier_id: 'sup-amn', supplier_sku: 'AMN-SF9028 SOFA', is_main_supplier: true,
      }],
    });
    expect(await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-SOFA' })).toBe(true);
    const [row] = outbox(sb);
    expect(row.status).not.toBe('skipped');
    expect(row.op).toBe('create_so');
    /* ONE line, and it carries the AutoCount code the binding named. */
    expect(row.payload.body.Details).toHaveLength(1);
    expect(row.payload.body.Details[0].ItemCode).toBe('AMN-SF9028 SOFA');
  });
});
