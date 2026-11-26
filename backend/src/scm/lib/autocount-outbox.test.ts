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
import { acNeedsAttention } from './autocount-outbox-status';
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
  const soItem = { doc_no: 'HC-SO-9', item_code: ERP_A, description: 'Mattress', qty: 2, unit_price_sen: 12345 };
  const po = {
    id: 'po-1', po_number: 'HC-PO-9', po_date: '2026-08-10',
    supplier_id: 'sup-1', notes: 'a note', linked_ac_docno: null,
  };
  const supplier = { id: 'sup-1', code: '400-H004', name: 'Supplier' };

  test('1. SO create', async () => {
    const sb = withFlag('1', { mfg_sales_orders: [{ ...so }], mfg_sales_order_items: [{ ...soItem }] });
    expect((await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-9' })).queued).toBe(true);
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
    expect((await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-9' })).queued).toBe(false);
    expect(outbox(sb)).toHaveLength(0);
  });

  test('2. PO create — the creditor comes from scm.suppliers, through supplier_id', async () => {
    const sb = withFlag('1', {
      purchase_orders: [{ ...po }],
      suppliers: [{ ...supplier }],
      purchase_order_items: [{ purchase_order_id: 'po-1', item_code: ERP_A, description: 'D', qty: 3, unit_price_sen: 5000, warehouse_id: 'wh-1' }],
      warehouses: [{ id: 'wh-1', code: 'KL', name: 'KL WAREHOUSE' }],
    }, {
      purchase_orders: ['creditor_code', 'creditor_name', 'agent', 'ref'],
    });
    expect((await enqueuePoCreate(sb as never, { companyId: 1, poId: 'po-1' })).queued).toBe(true);
    const [row] = outbox(sb);
    expect(row.op).toBe('create_po');
    expect(row.doc_no).toBe('HC-PO-9');
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
      purchase_order_items: [{ purchase_order_id: 'po-1', item_code: ERP_A, description: 'D', qty: 3, unit_price_sen: 5000, linked_ac_dtlkey: 7001 }],
    }, { purchase_orders: ['creditor_code', 'creditor_name', 'agent', 'ref'] });
    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'PO', docId: 'po-1' })).toBe(true);
    const [row] = outbox(sb);
    expect(row.op).toBe('edit');
    expect(row.doc_no).toBe('HC-PO-9');
    expect(row.payload.body.Header).toEqual({ CreditorName: 'Supplier', Description: 'a note' });
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
    expect((await enqueueConvert(sb as never, {
      companyId: 1,
      op: op as never,
      from: { table: fromTable as never, keyCol: 'id', key: 'src-1' },
      to: { table: toTable as never, keyCol: 'id', key: 'dst-1' },
      docType: docType as never,
      docNo: 'DOC-1',
      docId: 'dst-1',
    })).queued).toBe(true);
    const [row] = outbox(sb);
    expect(row.op).toBe(op);
    expect(row.doc_type).toBe(docType);
    expect(row.payload.body.DtlKeys).toBeUndefined();
    expect(row.payload.fromDoc.table).toBe(fromTable);
    expect(row.payload.writeback.table).toBe(toTable);
  });

  describe('a failed read is never an empty document', () => {
    const noDtlKey = { mfg_sales_order_items: ['linked_ac_dtlkey'], purchase_order_items: ['linked_ac_dtlkey'] };

    test('SO create: the line read fails -> nothing is queued, and it is written down', async () => {
      const sb = withFlag('1', {
        mfg_sales_orders: [{ ...so }], mfg_sales_order_items: [{ ...soItem }],
      }, noDtlKey);
      expect((await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-9' })).queued).toBe(false);
      const rows = outbox(sb);
      expect(rows.filter((r) => r.status === 'pending')).toHaveLength(0);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('skipped');
      expect(rows[0].last_error).toContain('42703');
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
        purchase_order_items: [{ purchase_order_id: 'po-1', item_code: ERP_A, qty: 1, unit_price_sen: 1 }],
      }, { purchase_orders: ['po_number'] });
      expect((await enqueuePoCreate(sb as never, { companyId: 1, poId: 'po-1' })).queued).toBe(false);
      const rows = outbox(sb);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('skipped');
      expect(rows[0].last_error).toContain('42703');
    });

    test('a read that finds NOTHING is still just nothing — no note, no row', async () => {
      const sb = withFlag('1', { mfg_sales_orders: [], mfg_sales_order_items: [] });
      expect((await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-404' })).queued).toBe(false);
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
    doc_no: 'HC-SO-9', so_date: null, debtor_name: 'ACME', agent: null, salesperson_id: 'staff-1', sales_location: 'KL',
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
      mfg_sales_order_items: [{ doc_no: 'HC-SO-9', item_code: ERP_A, description: 'before', qty: 1, unit_price_sen: 100 }],
    });
    await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-9' });
    expect(outbox(sb)[0].payload.body.Details[0].Description).toBe('before');

    sb.tables.mfg_sales_order_items[0].description = 'after';
    sb.tables.mfg_sales_order_items[0].qty = 4;
    resetWritebackFlagCache();
    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: 'HC-SO-9' })).toBe(true);

    const rows = outbox(sb);
    expect(rows).toHaveLength(1);
    expect(rows[0].op).toBe('create_so');
    expect(rows[0].payload.body.Details[0].Description).toBe('after');
    expect(rows[0].payload.body.Details[0].Qty).toBe(4);
  });

  test('editing a document AutoCount already has queues an edit that addresses its lines by DtlKey', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...so, linked_ac_docno: 'SO-000021' }],
      mfg_sales_order_items: [
        { doc_no: 'HC-SO-9', item_code: ERP_A, description: 'known line', qty: 1, unit_price_sen: 100, linked_ac_dtlkey: 4242 },
        { doc_no: 'HC-SO-9', item_code: ERP_B, description: 'other line', qty: 1, unit_price_sen: 200, linked_ac_dtlkey: 4243 },
      ],
    });
    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: 'HC-SO-9' })).toBe(true);
    const [row] = outbox(sb);
    expect(row.op).toBe('edit');
    expect(row.payload.body.Lines[0].DtlKey).toBe(4242);
    expect(row.payload.body.Lines[1].DtlKey).toBe(4243);
    expect(row.dedupe_key).toBeNull();
  });

  test('an edit whose line has no DtlKey is REFUSED and recorded as skipped, not queued', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...so, linked_ac_docno: 'SO-000021' }],
      mfg_sales_order_items: [
        { doc_no: 'HC-SO-9', item_code: ERP_A, description: 'keyed', qty: 1, unit_price_sen: 100, linked_ac_dtlkey: 4242 },
        { doc_no: 'HC-SO-9', item_code: ERP_B, description: 'keyless', qty: 1, unit_price_sen: 200, linked_ac_dtlkey: null },
      ],
    });
    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: 'HC-SO-9' })).toBe(false);

    const rows = outbox(sb);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('skipped');
    expect(rows[0].op).toBe('edit');
    expect(rows[0].last_error).toContain('refused, nothing sent');
    expect(rows[0].last_error).toContain('KeylessLineError');
    expect(rows[0].last_error).toContain('DtlKey');
    expect(rows[0].last_error).toContain(AC_B);
    expect(rows[0].last_error).not.toContain('no single AutoCount ItemCode');
    expect(rows.filter((r: Row) => r.status === 'pending')).toHaveLength(0);
  });

  test('editing a document AutoCount never received queues nothing', async () => {
    const sb = withFlag('1', { mfg_sales_orders: [{ ...so }], mfg_sales_order_items: [] });
    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: 'HC-SO-9' })).toBe(false);
    expect(outbox(sb)).toHaveLength(0);
  });
});



describe('a removed line is retired in AutoCount, never just left out', () => {
  const soHeader = {
    doc_no: 'HC-SO-9', so_date: null, debtor_name: 'ACME', agent: null, salesperson_id: 'staff-1', sales_location: 'KL',
    branding: null, venue: null, address1: null, address2: null, address3: null, address4: null,
    phone: null, ref: null, po_doc_no: null, linked_ac_docno: 'SO-000021',
  };
  const keyed = (over: Record<string, unknown> = {}) => ({
    id: 'so-item-1', doc_no: 'HC-SO-9', item_code: 'Y04-(K)', description: 'Mattress',
    qty: 2, unit_price_sen: 100, linked_ac_dtlkey: 7001, cancelled: false, ...over,
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
    expect((await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-9' })).queued).toBe(true);
    const [row] = outbox(sb);
    expect(row.payload.body.Details).toHaveLength(1);
    expect(row.payload.body.Details[0].ItemCode).toBe('AERO-Y04 (K)');
  });
});

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
    expect(calls.filter((c) => c.includes('/create-so'))).toHaveLength(0);
    expect(outbox(sb)[0].last_error).toContain('masters not opened');
  });

  test('a creditor the book holds under ANOTHER name is reported, document still goes', async () => {
    const sb = withFlag('1', { autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mismatched = [{ master: 'creditor:400-H004', erp: 'HOOKKA INDUSTRIES SDN. BHD.', book: 'HAO HUA FURNITURE' }];
    const fetchImpl = vi.fn(async (url: string) => (String(url).includes('/ensure-masters')
      ? jsonRes(200, { ok: true, mismatched }) : jsonRes(200, { ok: true, docNo: 'SO-000123' }))) as never;
    const outcome = await dispatchOne(env, sb as never, createRow({ DocNo: 'HC-SO-9', Details: [{ ItemCode: 'NEW-SKU' }] }), fetchImpl);
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    warn.mockRestore();
    expect(outcome).toBe('sent');
    expect(said).toContain('MISMATCH creditor:400-H004 erp=HOOKKA INDUSTRIES SDN. BHD. book=HAO HUA FURNITURE');
    expect(outbox(sb)[0].status).toBe('sent');
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

describe('the salesperson reaches AutoCount even when `agent` is empty', () => {
  const so = {
    doc_no: 'HC-SO-9', so_date: '2026-08-10', debtor_name: 'ACME',
    agent: null, salesperson_id: 'staff-1',
    sales_location: 'KL WAREHOUSE', branding: null, venue: null,
    address1: 'A1', address2: null, address3: null, address4: null,
    phone: '012', ref: 'R', po_doc_no: null, linked_ac_docno: null,
  };
  const soItem = { doc_no: 'HC-SO-9', item_code: ERP_A, description: 'Mattress', qty: 1, unit_price_sen: 100 };

  test('a create falls back to the name behind salesperson_id', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...so }], mfg_sales_order_items: [{ ...soItem }],
    });
    expect((await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-9' })).queued).toBe(true);
    expect(outbox(sb)[0].payload.body.Agent).toBe('Nurul Hidayah');
  });

  test('and /ensure-masters is therefore asked to open that agent', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...so }], mfg_sales_order_items: [{ ...soItem }],
    });
    await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-9' });
    const masters = mastersOf(outbox(sb)[0].payload.body as Record<string, unknown>);
    expect(masters?.Agents).toEqual([{ Agent: 'Nurul Hidayah' }]);
  });

  test('an agent the ERP does hold still wins over the salesperson link', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...so, agent: 'KRIS' }], mfg_sales_order_items: [{ ...soItem }],
    });
    await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-9' });
    expect(outbox(sb)[0].payload.body.Agent).toBe('KRIS');
  });

  test('an edit sends the fallback too, and omits Agent when neither source answers', async () => {
    const linked = { ...so, linked_ac_docno: 'SO-000021' };
    const keyed = { ...soItem, linked_ac_dtlkey: 991 };
    const withStaff = withFlag('1', {
      mfg_sales_orders: [{ ...linked }], mfg_sales_order_items: [{ ...keyed }],
    });
    await enqueueEdit(withStaff as never, { companyId: 1, docType: 'SO', docNo: 'HC-SO-9' });
    expect((outbox(withStaff)[0].payload.body.Header as Record<string, unknown>).Agent)
      .toBe('Nurul Hidayah');

    resetWritebackFlagCache();
    const without = withFlag('1', {
      mfg_sales_orders: [{ ...linked, salesperson_id: null }],
      mfg_sales_order_items: [{ ...keyed }],
    });
    await enqueueEdit(without as never, { companyId: 1, docType: 'SO', docNo: 'HC-SO-9' });
    expect(outbox(without)[0].payload.body.Header).not.toHaveProperty('Agent');
  });

  test('neither source: nothing is queued, and the refusal is written down', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...so, salesperson_id: null }],
      mfg_sales_order_items: [{ ...soItem }],
    });
    expect((await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-9' })).queued).toBe(false);
    const [row] = outbox(sb);
    expect(row.status).toBe('skipped');
    expect(row.last_error).toContain('refused, nothing sent (MissingAgentError)');
    expect(row.last_error).toContain('FK_SO_SalesAgent');
    expect(outbox(sb).filter((r) => r.status === 'pending')).toHaveLength(0);
  });

  test('an unreadable staff row is a compose failure, not a missing salesperson', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...so }], mfg_sales_order_items: [{ ...soItem }],
    }, { staff: ['name'] });
    expect((await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-9' })).queued).toBe(false);
    const [row] = outbox(sb);
    expect(row.status).toBe('skipped');
    expect(row.last_error).toContain('compose failed, nothing sent');
    expect(row.last_error).toContain('42703');
  });
});

describe('an edit carries the fields a create carries', () => {
  const so = {
    doc_no: 'HC-SO-9', so_date: '2026-08-10', debtor_name: 'ACME', agent: 'KAR JIUN',
    sales_location: 'PETALING JAYA', branding: 'AKEMI', venue: 'KSL CITY MALL',
    address1: 'A1', address2: null, address3: null, address4: null,
    phone: '012', ref: 'R', customer_so_no: 'CUST-PO-7', linked_ac_docno: 'SO-000021',
  };
  const item = {
    doc_no: 'HC-SO-9', item_code: ERP_A, description: 'M', qty: 1,
    unit_price_sen: 100, linked_ac_dtlkey: 991,
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
    expect(h.UDF).toEqual({ BRANDING: 'AKEMI', VENUE: 'KSL CITY MALL JOHOR SOLO' });
  });

  test('a field the ERP does not have is OMITTED, never sent as null that would blank the book', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...so, agent: null, sales_location: null, branding: null, venue: null, customer_so_no: null }],
      mfg_sales_order_items: [{ ...item }],
    });
    await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: 'HC-SO-9' });
    const h = outbox(sb)[0].payload.body.Header as Record<string, unknown>;
    expect(h).not.toHaveProperty('Agent');
    expect(h).not.toHaveProperty('SalesLocation');
    expect(h).not.toHaveProperty('UDF');
  });
});

describe('a line the ERP just added is declared, never inferred', () => {
  const so = {
    doc_no: 'HC-SO-9', so_date: null, debtor_name: 'ACME', agent: null, salesperson_id: 'staff-1', sales_location: 'KL',
    branding: null, venue: null, address1: null, address2: null, address3: null, address4: null,
    phone: null, ref: null, po_doc_no: null, linked_ac_docno: 'SO-000021',
  };
  const keyed = { id: 'row-old', doc_no: 'HC-SO-9', item_code: ERP_A, description: 'M', qty: 1, unit_price_sen: 100, linked_ac_dtlkey: 991 };
  const fresh = { id: 'row-new', doc_no: 'HC-SO-9', item_code: ERP_B, description: 'added', qty: 1, unit_price_sen: 200, linked_ac_dtlkey: null };

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

  test('another line is ALSO keyless: the document REBUILDS instead of refusing (0608)', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...so }],
      mfg_sales_order_items: [{ ...keyed, linked_ac_dtlkey: null, id: 'row-legacy' }, { ...fresh }],
    });
    expect(await enqueueEdit(sb as never, {
      companyId: 1, docType: 'SO', docNo: 'HC-SO-9', newLineIds: ['row-new'],
    })).toBe(true);
    expect((outbox(sb)[0].payload.body as Record<string, unknown>).Rebuild).toBe(true);
  });

  /* THE PURCHASE ORDER HALF, wired 2026-08-31. The contract is the sales
     order's, and the reason it took longer is written into the route it unlocks:
     a duplicate line on a purchase order cannot be removed in AutoCount, so
     "declared, never inferred" had to be proved on the safer document first.
     Owner 2026-08-31: 「给回写加"增行/删行"能力」 — delete already worked on all six
     document types; this is the add half. */
  describe('and the same contract on a purchase order', () => {
    const poDoc = {
      id: 'po-1', po_number: 'HC-PO-9', po_date: '2026-08-10', supplier_id: 'sup-1',
      notes: 'a note', linked_ac_docno: 'PO-000042', purchase_location_id: 'wh-1',
    };
    const sup = { id: 'sup-1', code: '400-H004', name: 'Supplier' };
    const poCols = { purchase_orders: ['creditor_code', 'creditor_name', 'agent', 'ref'] };
    const oldLine = {
      id: 'po-row-old', purchase_order_id: 'po-1', item_code: ERP_A, description: 'D',
      qty: 3, unit_price_sen: 5000, linked_ac_dtlkey: 7001, warehouse_id: 'wh-1',
    };
    const newLine = {
      id: 'po-row-new', purchase_order_id: 'po-1', item_code: ERP_B, description: 'added',
      qty: 1, unit_price_sen: 900, linked_ac_dtlkey: null, warehouse_id: 'wh-1',
    };
    const wh = [{ id: 'wh-1', code: 'KL', name: 'KL WAREHOUSE' }];

    test('declared by the route: the added line goes as IsNewLine, the keyed one does not', async () => {
      const sb = withFlag('1', {
        purchase_orders: [{ ...poDoc }], suppliers: [{ ...sup }],
        purchase_order_items: [{ ...oldLine }, { ...newLine }], warehouses: wh,
      }, poCols);
      expect(await enqueueEdit(sb as never, {
        companyId: 1, docType: 'PO', docId: 'po-1', newLineIds: ['po-row-new'],
      })).toBe(true);
      const lines = outbox(sb)[0].payload.body.Lines as Array<Record<string, unknown>>;
      expect(lines).toHaveLength(2);
      expect(lines.find((l) => l.DtlKey === 7001)?.IsNewLine).toBeUndefined();
      expect(lines.find((l) => l.ItemCode === AC_B)?.IsNewLine).toBe(true);
    });

    test('NOT declared: refused, named by the PO NUMBER so a person can act on it (0774)', async () => {
      const sb = withFlag('1', {
        purchase_orders: [{ ...poDoc }], suppliers: [{ ...sup }],
        purchase_order_items: [{ ...oldLine }, { ...newLine }], warehouses: wh,
      }, poCols);
      expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'PO', docId: 'po-1' })).toBe(false);
      expect(outbox(sb)[0]).toMatchObject({ doc_no: 'HC-PO-9', last_error: expect.stringContaining('refused, nothing sent') });
    });

    test('a new line with no warehouse of its own inherits the document\'s', async () => {
      const sb = withFlag('1', {
        purchase_orders: [{ ...poDoc }], suppliers: [{ ...sup }],
        purchase_order_items: [{ ...oldLine }, { ...newLine, warehouse_id: null }], warehouses: wh,
      }, poCols);
      expect(await enqueueEdit(sb as never, {
        companyId: 1, docType: 'PO', docId: 'po-1', newLineIds: ['po-row-new'],
      })).toBe(true);
      const lines = outbox(sb)[0].payload.body.Lines as Array<Record<string, unknown>>;
      expect(lines.find((l) => l.ItemCode === AC_B)?.Location).toBe('KL');
    });

    test('and when neither the line nor the document has one, the key is omitted rather than guessed', async () => {
      const sb = withFlag('1', {
        purchase_orders: [{ ...poDoc, purchase_location_id: null }], suppliers: [{ ...sup }],
        purchase_order_items: [{ ...oldLine }, { ...newLine, warehouse_id: null }], warehouses: wh,
      }, poCols);
      expect(await enqueueEdit(sb as never, {
        companyId: 1, docType: 'PO', docId: 'po-1', newLineIds: ['po-row-new'],
      })).toBe(true);
      const lines = outbox(sb)[0].payload.body.Lines as Array<Record<string, unknown>>;
      expect(lines.find((l) => l.ItemCode === AC_B)).not.toHaveProperty('Location');
    });

    test('an EXISTING line with no location still sends no Location key', async () => {
      const sb = withFlag('1', {
        purchase_orders: [{ ...poDoc }], suppliers: [{ ...sup }],
        purchase_order_items: [{ ...oldLine, warehouse_id: null }, { ...newLine }], warehouses: wh,
      }, poCols);
      expect(await enqueueEdit(sb as never, {
        companyId: 1, docType: 'PO', docId: 'po-1', newLineIds: ['po-row-new'],
      })).toBe(true);
      const lines = outbox(sb)[0].payload.body.Lines as Array<Record<string, unknown>>;
      expect(lines.find((l) => l.DtlKey === 7001)).not.toHaveProperty('Location');
    });
  });
});

describe('every document the ERP creates carries the ERP number', () => {
  const env = { AC_SYNC_URL: 'http://ac.local:8900', AC_SYNC_KEY: 'k' } as never;

  test('a conversion sends the CHILD document number, not the parent', async () => {
    const sb = withFlag('1', {
      delivery_orders: [{ id: 'do-1', do_number: 'DO-2608-004', linked_ac_docno: null }],
      mfg_sales_orders: [{ doc_no: 'HC-SO-9', linked_ac_docno: 'SO-000021' }],
      delivery_order_items: [],
    });
    expect((await enqueueConvert(sb as never, {
      companyId: 1,
      op: 'so_to_do',
      from: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
      to: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
      docType: 'DO',
      docNo: 'DO-2608-004',
      docId: 'do-1',
    })).queued).toBe(true);
    const body = outbox(sb)[0].payload.body as Record<string, unknown>;
    expect(body.DocNo).toBe('DO-2608-004');
    expect(body.FromDocNo).toBeUndefined();
    expect(outbox(sb)[0].payload.fromDoc).toBeTruthy();
  });

  test('a create still sends its own number, unchanged', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{
        doc_no: 'HC-SO-9', so_date: null, debtor_name: 'A', agent: null, salesperson_id: 'staff-1', sales_location: 'KL',
        branding: null, venue: null, address1: null, address2: null, address3: null,
        address4: null, phone: null, ref: null, po_doc_no: null, linked_ac_docno: null,
      }],
      mfg_sales_order_items: [{ id: 'i1', doc_no: 'HC-SO-9', item_code: ERP_A, description: 'M', qty: 1, unit_price_sen: 100 }],
    });
    expect((await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-9' })).queued).toBe(true);
    expect((outbox(sb)[0].payload.body as Record<string, unknown>).DocNo).toBe('HC-SO-9');
  });
});

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
    expect(m.Locations.map((l) => l.Location).sort()).toEqual(['KL', 'PG']);
  });

  test('the PURCHASE header\'s warehouse too, not only the sales header\'s', () => {
    const m = mastersOf({
      PurchaseLocation: 'PG',
      Details: [{ ItemCode: 'A', Location: 'PG' }],
    }) as { Locations: Array<Record<string, unknown>> };
    expect(m.Locations.map((l) => l.Location)).toEqual(['PG']);

    const headerOnly = mastersOf({
      PurchaseLocation: 'HQ',
      Details: [{ ItemCode: 'A' }],
    }) as { Locations: Array<Record<string, unknown>> };
    expect(
      headerOnly.Locations.map((l) => l.Location),
      'the header alone must open it — a PO whose lines inherit name it nowhere else',
    ).toEqual(['HQ']);
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
    expect(m.UdfOptions.find((o) => o.List === 'ToPONo')).toBeUndefined();
  });

  test('no UDF block, no options — nothing is invented from an absent field', () => {
    const m = mastersOf({ Details: [{ ItemCode: 'A', Location: 'KL' }] }) as { UdfOptions: unknown[] };
    expect(m.UdfOptions).toEqual([]);
  });
});

describe('a sofa resolves through the binding recorded for its model', () => {
  const sofaSo = {
    doc_no: 'HC-SO-SOFA', so_date: '2026-08-13', debtor_name: 'LIM',
    agent: null, salesperson_id: 'staff-1',
    sales_location: 'KL WAREHOUSE', branding: null, venue: null,
    address1: null, address2: null, address3: null, address4: null,
    phone: null, ref: null, po_doc_no: null, linked_ac_docno: null,
  };
  const compartments = ['1A(LHF)', '2A(RHF)'].map((comp, i) => ({
    doc_no: 'HC-SO-SOFA',
    item_code: `9028-${comp}`,
    item_group: 'sofa',
    description: `SOFA 9028 ${comp}`,
    description2: '1A(LHF) + 2A(RHF) (28")',
    qty: 1,
    unit_price_sen: i === 0 ? 399000 : 0,
    location: 'KL',
  }));

  test('with NO binding at all it now sends, one line per compartment', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...sofaSo }],
      mfg_sales_order_items: compartments.map((l) => ({ ...l })),
      supplier_material_bindings: [],
    });
    expect((await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-SOFA' })).queued).toBe(true);
    const [row] = outbox(sb);
    expect(row.status).not.toBe('skipped');
    expect(row.payload.body.Details.map((d: { ItemCode: string }) => d.ItemCode))
      .toEqual(['9028-1A(LHF)', '9028-2A(RHF)']);
  });

  test('a binding on the COMPARTMENT is found and the document sends', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...sofaSo }],
      mfg_sales_order_items: compartments.map((l) => ({ ...l })),
      supplier_material_bindings: [{
        company_id: 1, item_code: '9028-1A(LHF)', material_kind: 'mfg_product',
        supplier_id: 'sup-amn', supplier_sku: 'AMN-SF9028 SOFA', is_main_supplier: true,
      }],
    });
    expect((await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-SOFA' })).queued).toBe(true);
    const [row] = outbox(sb);
    expect(row.status).not.toBe('skipped');
    expect(row.op).toBe('create_so');
    expect(row.payload.body.Details.map((d: { ItemCode: string }) => d.ItemCode))
      .toEqual(['AMN-SF9028 SOFA', '9028-2A(RHF)']);
  });
});

type FakeClient = Parameters<typeof enqueueSoCreate>[0];
const client = (sb: unknown): FakeClient => sb as FakeClient;

describe('the columns the write-back reads are the columns the ERP writes', () => {
  const so = {
    doc_no: 'HC-SO-A', so_date: '2026-08-10', debtor_name: 'ACME', company_id: 1,
    agent: null, salesperson_id: 'staff-1',
    sales_location: 'KL WAREHOUSE', branding: null, venue: '2990s PJ',
    address1: 'No 1, Jalan Besar', address2: 'Taman Sentosa',
    address3: null, address4: null,
    city: 'Seri Kembangan', postcode: '43300', customer_state: 'Selangor',
    phone: '012', ref: null,
    po_doc_no: null, customer_po: null, customer_so_no: 'THEIR-SO-88',
    processing_date: null, linked_ac_docno: null,
  };
  const item = {
    doc_no: 'HC-SO-A', item_code: ERP_A, branding: 'DUNLOPILLO',
    description: 'Mattress', qty: 1, unit_price_sen: 100,
  };
  const seeded = () => withFlag('1', {
    mfg_sales_orders: [{ ...so }], mfg_sales_order_items: [{ ...item }],
  });

  test('a create carries the venue, the line brand, the customer ref and the full address', async () => {
    const sb = seeded();
    expect((await enqueueSoCreate(client(sb), { companyId: 1, docNo: 'HC-SO-A' })).queued).toBe(true);
    const body = outbox(sb)[0].payload.body as Record<string, unknown>;
    expect(body.UDF).toEqual({
      VENUE: '2990s PJ', BRANDING: 'DUNLOPILLO',
    });
    expect(body.InvAddr1).toBe('No 1, Jalan Besar');
    expect(body.InvAddr2).toBe('Taman Sentosa');
    expect(body.InvAddr3).toBe('43300 Seri Kembangan');
    expect(body.InvAddr4).toBe('Selangor');
    expect(body.SalesLocation).toBe('KL');
  });

  test('and the venue it passed through is one /ensure-masters is asked to open', async () => {
    const sb = seeded();
    await enqueueSoCreate(client(sb), { companyId: 1, docNo: 'HC-SO-A' });
    const m = mastersOf(outbox(sb)[0].payload.body as Record<string, unknown>) as {
      UdfOptions: Array<Record<string, string>>; Locations: Array<Record<string, string>>;
    };
    expect(m.UdfOptions).toContainEqual({ List: 'VENUE', Value: '2990s PJ' });
    expect(m.UdfOptions).toContainEqual({ List: 'BRANDING', Value: 'DUNLOPILLO' });
    expect(m.Locations).toEqual([{ Location: 'KL' }]);
  });

  test('an order with no sales location takes one from its lines rather than failing the FK', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...so, sales_location: null }],
      mfg_sales_order_items: [{ ...item, warehouse_id: 'wh-pg' }],
      warehouses: [{ id: 'wh-pg', code: 'PG', name: 'PG WAREHOUSE' }],
    });
    expect((await enqueueSoCreate(client(sb), { companyId: 1, docNo: 'HC-SO-A' })).queued).toBe(true);
    const body = outbox(sb)[0].payload.body as Record<string, unknown>;
    expect(body.SalesLocation).toBe('PG');
    expect(outbox(sb)[0].status).not.toBe('skipped');
  });

  test('an edit omits every header field the ERP has nothing for, instead of blanking the book', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{
        ...so, linked_ac_docno: 'SO-000021',
        debtor_name: null, phone: null, ref: null, customer_so_no: null,
        address1: null, address2: null, city: null, postcode: null, customer_state: null,
      }],
      mfg_sales_order_items: [{ ...item, linked_ac_dtlkey: 991 }],
    });
    expect(await enqueueEdit(client(sb), { companyId: 1, docType: 'SO', docNo: 'HC-SO-A' })).toBe(true);
    const h = outbox(sb)[0].payload.body.Header as Record<string, unknown>;
    for (const k of ['DebtorName', 'Attention', 'Ref', 'Phone1',
      'InvAddr1', 'InvAddr2', 'InvAddr3', 'InvAddr4']) {
      expect(Object.prototype.hasOwnProperty.call(h, k), k).toBe(false);
    }
  });

  test('an edit still SENDS the fields the ERP does have', async () => {
    const sb = withFlag('1', {
      mfg_sales_orders: [{ ...so, linked_ac_docno: 'SO-000021' }],
      mfg_sales_order_items: [{ ...item, linked_ac_dtlkey: 991 }],
    });
    await enqueueEdit(client(sb), { companyId: 1, docType: 'SO', docNo: 'HC-SO-A' });
    const h = outbox(sb)[0].payload.body.Header as Record<string, unknown>;
    expect(h.InvAddr3).toBe('43300 Seri Kembangan');
    expect(h.InvAddr4).toBe('Selangor');
    expect(h.UDF).toEqual({
      VENUE: '2990s PJ', BRANDING: 'DUNLOPILLO',
    });
  });
});

/* ── WHAT THE CUTOVER EXTRACTED, SENT BACK ───────────────────────────────────
   Owner's rule: "他抽取了什么东西，就代表什么东西都是要进来的" — whatever the
   cutover pulled OUT of AutoCount is what the write-back has to put back. Three
   header/line fields were in `backend/scripts/data/ac-fidelity-so-*.json.gz`
   and in no payload, and each one is the recurring shape: the ERP holds the
   value in a column the composer was not reading.

   END-TO-END, not composer-only, for the reason the block above gives: the
   defect lives in the SELECT LIST as much as in the compose, and a column list
   is only exercised by a read. */
describe('the three fields the extract carries and the write-back did not send', () => {
  const so = {
    doc_no: 'HC-SO-B', so_date: '2026-08-10', debtor_name: 'ACME', company_id: 1,
    agent: null, salesperson_id: 'staff-1',
    sales_location: 'KL WAREHOUSE', branding: null, venue: null,
    address1: 'A1', address2: null, address3: null, address4: null,
    city: null, postcode: null, customer_state: null,
    phone: '012-1111111', emergency_contact_phone: '019-2222222',
    ref: null, po_doc_no: null, customer_po: null, customer_so_no: null,
    processing_date: null,
    total_revenue_sen: 500_00, balance_sen: 500_00, deposit_sen: 0,
    linked_ac_docno: null,
  };
  const item = {
    doc_no: 'HC-SO-B', item_code: ERP_A, description: 'Mattress',
    qty: 1, unit_price_sen: 500_00, line_delivery_date: null,
  };
  const seed = (soOver: Row = {}, itemOver: Row = {}, extra: Record<string, Row[]> = {}) =>
    withFlag('1', {
      mfg_sales_orders: [{ ...so, ...soOver }],
      mfg_sales_order_items: [{ ...item, ...itemOver }],
      ...extra,
    });

  describe('BALANCE — the outstanding amount, from the payments ledger and NOT from balance_sen', () => {
    test('a create sends total minus the payments ledger, not the stored balance_sen', async () => {
      const sb = seed({}, {}, {
        mfg_sales_order_payments: [
          { so_doc_no: 'HC-SO-B', amount_sen: 200_00, is_deposit: true },
          { so_doc_no: 'HC-SO-B', amount_sen: 100_00, is_deposit: false },
        ],
      });
      expect((await enqueueSoCreate(client(sb), { companyId: 1, docNo: 'HC-SO-B' })).queued).toBe(true);
      const udf = (outbox(sb)[0].payload.body as Record<string, Record<string, string>>).UDF;
      expect(udf.BALANCE).toBe('200.00');
    });

    test('a legacy header deposit counts once — and only when the ledger has no is_deposit row', async () => {
      const legacy = seed({ deposit_sen: 150_00 }, {}, {
        mfg_sales_order_payments: [{ so_doc_no: 'HC-SO-B', amount_sen: 50_00, is_deposit: false }],
      });
      await enqueueSoCreate(client(legacy), { companyId: 1, docNo: 'HC-SO-B' });
      expect((outbox(legacy)[0].payload.body as Record<string, Record<string, string>>).UDF.BALANCE)
        .toBe('300.00');

      const modern = seed({ deposit_sen: 150_00 }, {}, {
        mfg_sales_order_payments: [{ so_doc_no: 'HC-SO-B', amount_sen: 150_00, is_deposit: true }],
      });
      await enqueueSoCreate(client(modern), { companyId: 1, docNo: 'HC-SO-B' });
      expect((outbox(modern)[0].payload.body as Record<string, Record<string, string>>).UDF.BALANCE)
        .toBe('350.00');
    });

    test('a fully paid order sends 0.00 rather than dropping the key', async () => {
      const sb = seed({}, {}, {
        mfg_sales_order_payments: [{ so_doc_no: 'HC-SO-B', amount_sen: 500_00, is_deposit: true }],
      });
      await enqueueSoCreate(client(sb), { companyId: 1, docNo: 'HC-SO-B' });
      expect((outbox(sb)[0].payload.body as Record<string, Record<string, string>>).UDF.BALANCE)
        .toBe('0.00');
    });

    test('an EDIT carries it too, so a payment taken after the create reaches the book', async () => {
      const sb = seed({ linked_ac_docno: 'SO-000021' }, { linked_ac_dtlkey: 991 }, {
        mfg_sales_order_payments: [{ so_doc_no: 'HC-SO-B', amount_sen: 400_00, is_deposit: true }],
      });
      expect(await enqueueEdit(client(sb), { companyId: 1, docType: 'SO', docNo: 'HC-SO-B' })).toBe(true);
      const h = outbox(sb)[0].payload.body.Header as Record<string, Record<string, string>>;
      expect(h.UDF.BALANCE).toBe('100.00');
    });

    test('an order with no total sends no BALANCE at all', async () => {
      const sb = seed({ total_revenue_sen: null, linked_ac_docno: 'SO-000021' }, { linked_ac_dtlkey: 991 });
      await enqueueEdit(client(sb), { companyId: 1, docType: 'SO', docNo: 'HC-SO-B' });
      const h = outbox(sb)[0].payload.body.Header as Record<string, unknown>;
      expect(h).not.toHaveProperty('UDF');
    });
  });

  /* ── CLEARING, which is not the same as never having had a value ──────────
     Every key above is omitted when the ERP column is empty, and that rule is
     right for an order that never had a Ref — blanking would destroy what an
     operator typed into AutoCount. It also made the OPPOSITE intent
     inexpressible: deleting a value in the ERP produced silence and the book
     kept the old one. Owner 2026-08-15: "任何情况 ERP update 就是都要跟".

     The composer reads the SAVED row, where both cases are an empty column, so
     the ROUTE says which fields it wrote — the same contract as newLineIds and
     for the same reason. */
  describe('a field the operator DELETED is cleared, not left alone', () => {
    const linked = (over: Row = {}) =>
      seed({ linked_ac_docno: 'SO-000021', ...over }, { linked_ac_dtlkey: 991 });
    const header = (sb: { tables: Record<string, Row[]> }) =>
      outbox(sb)[0].payload.body.Header as Record<string, unknown>;

    test('an untouched blank field is still OMITTED — the book keeps its own', async () => {
      const sb = linked({ ref: null });
      await enqueueEdit(client(sb), { companyId: 1, docType: 'SO', docNo: 'HC-SO-B' });
      expect(header(sb)).not.toHaveProperty('Ref');
    });

    test('a TOUCHED blank field is sent as an explicit null', async () => {
      const sb = linked({ ref: null });
      await enqueueEdit(client(sb), {
        companyId: 1, docType: 'SO', docNo: 'HC-SO-B', touchedFields: ['ref'],
      });
      expect(header(sb)).toHaveProperty('Ref', null);
    });

    test('a touched field that still has a value sends the value', async () => {
      const sb = linked({ ref: 'PO-778' });
      await enqueueEdit(client(sb), {
        companyId: 1, docType: 'SO', docNo: 'HC-SO-B', touchedFields: ['ref'],
      });
      expect(header(sb)).toHaveProperty('Ref', 'PO-778');
    });

    test('the salesperson and the stock location are never nulled, even when touched', async () => {
      const sb = linked();
      await enqueueEdit(client(sb), {
        companyId: 1,
        docType: 'SO',
        docNo: 'HC-SO-B',
        touchedFields: ['agent', 'salesperson_id', 'sales_location', 'debtor_name'],
      });
      const h = header(sb);
      expect(h.Agent).not.toBeNull();
      expect(h.SalesLocation).not.toBeNull();
      expect(h.DebtorName).not.toBeNull();
    });

    test('touching any address column sends all four InvAddr keys', async () => {
      const sb = linked({ address2: null, address3: null, address4: null });
      await enqueueEdit(client(sb), {
        companyId: 1, docType: 'SO', docNo: 'HC-SO-B', touchedFields: ['address2'],
      });
      const h = header(sb);
      for (const k of ['InvAddr1', 'InvAddr2', 'InvAddr3', 'InvAddr4']) {
        expect(h, k).toHaveProperty(k);
      }
    });

    test('a cleared processing date empties the PDate UDF', async () => {
      const sb = linked({ processing_date: null });
      await enqueueEdit(client(sb), {
        companyId: 1, docType: 'SO', docNo: 'HC-SO-B', touchedFields: ['processing_date'],
      });
      const udf = (header(sb).UDF ?? {}) as Record<string, string>;
      expect(udf).toHaveProperty('PDate', '');
    });

    /* Owner 2026-08-31: "你确保我 remove 了之后,它也是会 send 回去 AutoCount 的."
       Removing the pair is ONE save that clears TWO fields living on two
       different sides of the payload — the Processing Date is a UDF, the
       Delivery Date is a header column — so the pair is asserted together. */
    test('clearing the whole date pair blanks both the UDF and the header date', async () => {
      const sb = linked({ processing_date: null, customer_delivery_date: null });
      await enqueueEdit(client(sb), {
        companyId: 1,
        docType: 'SO',
        docNo: 'HC-SO-B',
        touchedFields: ['processing_date', 'customer_delivery_date'],
      });
      const h = header(sb);
      expect((h.UDF ?? {}) as Record<string, string>).toHaveProperty('PDate', '');
      expect(h).toHaveProperty('SalesExemptionExpiryDate', null);
    });
  });

  describe('PAYEMENT — the payment references go back into the field they came from', () => {
    test('a create carries the account sheet and approval code', async () => {
      const sb = seed({}, {}, {
        mfg_sales_order_payments: [
          { so_doc_no: 'HC-SO-B', amount_sen: 200_00, is_deposit: true, account_sheet: 'MAYBANK', approval_code: '111', paid_at: '2026-08-01', id: 'p1' },
          { so_doc_no: 'HC-SO-B', amount_sen: 100_00, is_deposit: false, account_sheet: 'CIMB', approval_code: '222', paid_at: '2026-08-02', id: 'p2' },
        ],
      });
      expect((await enqueueSoCreate(client(sb), { companyId: 1, docNo: 'HC-SO-B' })).queued).toBe(true);
      const udf = (outbox(sb)[0].payload.body as Record<string, Record<string, string>>).UDF;
      expect(udf.PAYEMENT).toBe('(MAYBANK/111) (CIMB/222)');
    });

    test('an EDIT carries it too, so a reference typed after the create reaches the book', async () => {
      const sb = seed({ linked_ac_docno: 'HC-SO-B' }, { linked_ac_dtlkey: 991 }, {
        mfg_sales_order_payments: [
          { so_doc_no: 'HC-SO-B', amount_sen: 400_00, is_deposit: true, account_sheet: 'Cash', approval_code: null, paid_at: '2026-08-01', id: 'p1' },
        ],
      });
      expect(await enqueueEdit(client(sb), { companyId: 1, docType: 'SO', docNo: 'HC-SO-B' })).toBe(true);
      const h = outbox(sb)[0].payload.body.Header as Record<string, Record<string, string>>;
      expect(h.UDF.PAYEMENT).toBe('(Cash/)');
    });

    test('payments with no references send no PAYEMENT key', async () => {
      const sb = seed({ linked_ac_docno: 'SO-000021' }, { linked_ac_dtlkey: 991 }, {
        mfg_sales_order_payments: [
          { so_doc_no: 'HC-SO-B', amount_sen: 400_00, is_deposit: true, account_sheet: null, approval_code: null, paid_at: '2026-08-01', id: 'p1' },
        ],
      });
      await enqueueEdit(client(sb), { companyId: 1, docType: 'SO', docNo: 'HC-SO-B' });
      const h = outbox(sb)[0].payload.body.Header as Record<string, Record<string, string>>;
      expect(h.UDF).not.toHaveProperty('PAYEMENT');
    });
  });

  describe('DeliverPhone1 — the DELIVERY contact, which is not the customer\'s phone', () => {
    /* Two contacts, two columns (owner 2026-08-15). The pairing is the
       cutover's own, read backwards: import-ac-outstanding-so.mjs:302 took
       AutoCount's DeliverPhone1 into emergency_contact_phone. Reading `phone`
       for both would put the customer's number in front of the driver. */
    test('a create sends emergency_contact_phone, and the customer phone stays Phone', async () => {
      const sb = seed();
      await enqueueSoCreate(client(sb), { companyId: 1, docNo: 'HC-SO-B' });
      const body = outbox(sb)[0].payload.body as Record<string, unknown>;
      expect(body.Phone).toBe('012-1111111');
      expect(body.DeliverPhone1).toBe('019-2222222');
    });

    test('an EDIT sends it too — this is where a changed delivery number was lost', async () => {
      const sb = seed({ linked_ac_docno: 'SO-000021' }, { linked_ac_dtlkey: 991 });
      await enqueueEdit(client(sb), { companyId: 1, docType: 'SO', docNo: 'HC-SO-B' });
      const h = outbox(sb)[0].payload.body.Header as Record<string, unknown>;
      expect(h.Phone1).toBe('012-1111111');
      expect(h.DeliverPhone1).toBe('019-2222222');
    });

    test('no second contact sends no key on an edit, and null on a create', async () => {
      const edit = seed({ emergency_contact_phone: null, linked_ac_docno: 'SO-000021' }, { linked_ac_dtlkey: 991 });
      await enqueueEdit(client(edit), { companyId: 1, docType: 'SO', docNo: 'HC-SO-B' });
      expect(outbox(edit)[0].payload.body.Header as Record<string, unknown>)
        .not.toHaveProperty('DeliverPhone1');

      const create = seed({ emergency_contact_phone: null });
      await enqueueSoCreate(client(create), { companyId: 1, docNo: 'HC-SO-B' });
      expect((outbox(create)[0].payload.body as Record<string, unknown>).DeliverPhone1).toBeNull();
    });
  });

  /* Desc2 is the SECOND DESCRIPTION LINE, and the cutover PARSED it to get the
     ERP's variants — so the specification goes back through the ERP's own
     renderer.

     It is NOT `FurtherDescription`, and this comment said it was until
     2026-08-15. They are separate columns on the same detail class
     (`sdk-api-reference.txt` lists both in every `SET:` list): Desc2 is
     nvarchar(100) and carries the build text; FurtherDescription is
     nvarchar(MAX) and carries the PHOTOGRAPHS, which is what
     `import-so-line-photos.mjs` pulled out at cutover. The names mattered
     little while nothing wrote FurtherDescription; now that something does,
     conflating them points a photograph at a 100-character column.

     The ceiling belongs to Desc2 alone: SODTL.Desc2 is nvarchar(100) and the
     book is AT it (longest of the extract's 15,950 values is exactly 100), so a
     richer string can now reach it and SQL Server would take the whole document.
     A refusal nobody can see is indistinguishable from a write-back that quietly
     stopped working, so it lands under its own CLASS NAME — the health check
     buckets on that name, and matching the shared "refused, nothing sent" prefix
     is the mislabelling #2094 already had to undo. */
  describe('Desc2 — the ERP\'s own renderer, and AutoCount\'s 100-character ceiling', () => {
    test('a bedframe carries the colour, the divan, the leg and the gap into Desc2', async () => {
      const sb = seed({}, {
        description2: null,
        item_group: 'bedframe',
        variants: { fabricCode: 'PC151-01', colourLabel: 'Sand', divanHeight: '8"', legHeight: '2"', gap: '12"' },
      });
      expect((await enqueueSoCreate(client(sb), { companyId: 1, docNo: 'HC-SO-B' })).queued).toBe(true);
      const d = (outbox(sb)[0].payload.body as { Details: Array<Record<string, unknown>> }).Details[0];
      expect(d.Desc2).toBe('PC151-01 Sand / DIVAN 8" + LEG 2" / GAP 12"');
    });

    test('a Further Description over nvarchar(100) — the COLOUR — is refused into a NAMED skipped row', async () => {
      const sb = seed({}, {
        description2: null,
        item_group: 'bedframe',
        variants: { fabricCode: `PC151-01 ${'X'.repeat(120)}`, gap: '12"' },
      });
      expect((await enqueueSoCreate(client(sb), { companyId: 1, docNo: 'HC-SO-B' })).queued).toBe(false);
      const [row] = outbox(sb);
      expect(row.status).toBe('skipped');
      expect(row.last_error).toContain('refused, nothing sent (Desc2TooLongError)');
      expect(outbox(sb).some((r) => r.status === 'pending')).toBe(false);
    });
  });

  describe('the line delivery date, including the BLANK the book itself holds', () => {
    test('a create sends the ERP line date', async () => {
      const sb = seed({}, { line_delivery_date: '2026-09-01' });
      await enqueueSoCreate(client(sb), { companyId: 1, docNo: 'HC-SO-B' });
      const d = (outbox(sb)[0].payload.body as { Details: Array<Record<string, unknown>> }).Details[0];
      expect(d.DeliveryDate).toBe('2026-09-01');
    });

    test('a create with no ERP date sends the key as an explicit null, not as an omission', async () => {
      const sb = seed();
      await enqueueSoCreate(client(sb), { companyId: 1, docNo: 'HC-SO-B' });
      const d = (outbox(sb)[0].payload.body as { Details: Array<Record<string, unknown>> }).Details[0];
      expect(Object.prototype.hasOwnProperty.call(d, 'DeliveryDate')).toBe(true);
      expect(d.DeliveryDate).toBeNull();
    });

    test('an EDIT omits the key when the ERP has none, and sends it when it does', async () => {
      const blank = seed({ linked_ac_docno: 'SO-000021' }, { linked_ac_dtlkey: 991 });
      await enqueueEdit(client(blank), { companyId: 1, docType: 'SO', docNo: 'HC-SO-B' });
      const noDate = (outbox(blank)[0].payload.body as { Lines: Array<Record<string, unknown>> }).Lines[0];
      expect(Object.prototype.hasOwnProperty.call(noDate, 'DeliveryDate')).toBe(false);

      const dated = seed({ linked_ac_docno: 'SO-000021' }, { linked_ac_dtlkey: 991, line_delivery_date: '2026-09-05' });
      await enqueueEdit(client(dated), { companyId: 1, docType: 'SO', docNo: 'HC-SO-B' });
      const withDate = (outbox(dated)[0].payload.body as { Lines: Array<Record<string, unknown>> }).Lines[0];
      expect(withDate.DeliveryDate).toBe('2026-09-05');
    });

    test('a purchase order reads purchase_order_items.delivery_date', async () => {
      const sb = withFlag('1', {
        purchase_orders: [{
          id: 'po-b', po_number: 'HC-PO-B', po_date: '2026-08-10',
          supplier_id: 'sup-1', notes: null, company_id: 1, linked_ac_docno: null,
        }],
        suppliers: [{ id: 'sup-1', code: '400-H004', name: 'Supplier' }],
        purchase_order_items: [{
          purchase_order_id: 'po-b', item_code: ERP_A, description: 'M',
          qty: 1, unit_price_sen: 100, warehouse_id: 'wh-kl', delivery_date: '2026-10-02',
        }],
        warehouses: [{ id: 'wh-kl', code: 'KL', name: 'KL WAREHOUSE' }],
      });
      expect((await enqueuePoCreate(client(sb), { companyId: 1, poId: 'po-b' })).queued).toBe(true);
      const d = (outbox(sb)[0].payload.body as { Details: Array<Record<string, unknown>> }).Details[0];
      expect(d.DeliveryDate).toBe('2026-10-02');
    });
  });
});

describe("mastersOf can see an EDIT payload's header, not just its lines", () => {
  const editBody = (over: Record<string, unknown> = {}) => ({
    DocType: 'SO', DocNo: 'SO-000021',
    Header: {
      Agent: 'Nurul Hidayah', SalesLocation: 'SUNWAY',
      UDF: { VENUE: 'AEON BIG KEPONG', BRANDING: 'CARRESS' },
      ...over,
    },
    Lines: [{ DtlKey: 991, Qty: 1 }],
  });

  test('the agent, the location and both dropdown options are opened', () => {
    const m = mastersOf(editBody()) as {
      Agents: Array<Record<string, string>>;
      Locations: Array<Record<string, string>>;
      UdfOptions: Array<Record<string, string>>;
    };
    expect(m.Agents).toEqual([{ Agent: 'Nurul Hidayah' }]);
    expect(m.Locations).toEqual([{ Location: 'SUNWAY' }]);
    expect(m.UdfOptions).toContainEqual({ List: 'VENUE', Value: 'AEON BIG KEPONG' });
    expect(m.UdfOptions).toContainEqual({ List: 'BRANDING', Value: 'CARRESS' });
  });

  test("a PO edit's agent goes to the PURCHASE agent master, with no CreditorCode to say so", () => {
    const m = mastersOf({
      DocType: 'PO', DocNo: 'PO-000021',
      Header: { Agent: 'OTHERS', CreditorName: 'NICOLLO' },
      Lines: [{ DtlKey: 5, Qty: 1 }],
    }) as { Agents: unknown[]; PurchaseAgents: Array<Record<string, string>> };
    expect(m.PurchaseAgents).toEqual([{ PurchaseAgent: 'OTHERS' }]);
    expect(m.Agents).toEqual([]);
  });

  test('a create payload is unaffected — the top level still wins', () => {
    const m = mastersOf({
      Agent: 'TOP', SalesLocation: 'KL', UDF: { VENUE: 'V1' },
      Details: [{ ItemCode: 'A' }],
    }) as { Agents: Array<Record<string, string>>; UdfOptions: Array<Record<string, string>> };
    expect(m.Agents).toEqual([{ Agent: 'TOP' }]);
    expect(m.UdfOptions).toEqual([{ List: 'VENUE', Value: 'V1' }]);
  });
});

describe('every purchase order names a purchase agent (FK_PO_PurchaseAgent)', () => {
  const seeded = () => withFlag('1', {
    purchase_orders: [{
      id: 'po-1', company_id: 1, po_number: 'HC-PO-1', po_date: '2026-08-10',
      supplier_id: 'sup-1', notes: null, linked_ac_docno: null,
    }],
    purchase_order_items: [{
      id: 'poi-1', purchase_order_id: 'po-1', item_code: ERP_A, description: 'M',
      qty: 1, unit_price_sen: 100, warehouse_id: 'wh-kl',
    }],
    warehouses: [{ id: 'wh-kl', code: 'KL', name: 'KL WAREHOUSE' }],
    suppliers: [{ id: 'sup-1', code: '400-N002', name: 'NICOLLO SDN BHD' }],
  });

  test('the payload carries the constant, never a null', async () => {
    const sb = seeded();
    expect((await enqueuePoCreate(client(sb), { companyId: 1, poId: 'po-1' })).queued).toBe(true);
    expect(outbox(sb)[0].payload.body.Agent).toBe('OTHERS');
  });

  test('and /ensure-masters is asked for it as a PURCHASE agent, not a sales one', async () => {
    const sb = seeded();
    await enqueuePoCreate(client(sb), { companyId: 1, poId: 'po-1' });
    const m = mastersOf(outbox(sb)[0].payload.body as Record<string, unknown>) as {
      Agents: unknown[]; PurchaseAgents: Array<Record<string, string>>;
    };
    expect(m.PurchaseAgents).toEqual([{ PurchaseAgent: 'OTHERS' }]);
    expect(m.Agents).toEqual([]);
  });

  test('a supplier with no code lands a SKIPPED row naming the constraint', async () => {
    const sb = seeded();
    sb.tables.suppliers[0].code = null;
    expect((await enqueuePoCreate(client(sb), { companyId: 1, poId: 'po-1' })).queued).toBe(false);
    const [row] = outbox(sb);
    expect(row.status).toBe('skipped');
    expect(row.last_error).toContain('FK_PO_Creditor');
    expect(row.last_error).toContain('MissingCreditorError');
  });
});

describe("a conversion says nothing rather than blanking the target's reference", () => {
  const seeded = () => withFlag('1', {
    delivery_orders: [{ id: 'do-1', do_number: 'HC-DO-1', linked_ac_docno: null }],
    delivery_order_items: [],
  });

  test('no ref and no date means neither key is present at all', async () => {
    const sb = seeded();
    expect((await enqueueConvert(client(sb), {
      companyId: 1, op: 'so_to_do', docType: 'DO', docNo: 'HC-DO-1', docId: 'do-1',
      from: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-1' },
      to: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
    })).queued).toBe(true);
    const body = outbox(sb)[0].payload.body as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(body, 'Ref')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, 'DocDate')).toBe(false);
    expect(body.DocNo).toBe('HC-DO-1');
  });

  test('a ref the caller DOES pass is still sent', async () => {
    const sb = seeded();
    await enqueueConvert(client(sb), {
      companyId: 1, op: 'so_to_do', docType: 'DO', docNo: 'HC-DO-1', docId: 'do-1',
      ref: 'DN-99', docDate: '2026-08-14',
      from: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-1' },
      to: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
    });
    const body = outbox(sb)[0].payload.body as Record<string, unknown>;
    expect(body.Ref).toBe('DN-99');
    expect(body.DocDate).toBe('2026-08-14');
  });

  test('what the document is going WITHOUT is on the row, and does not read as a failure', async () => {
    const sb = seeded();
    await enqueueConvert(client(sb), {
      companyId: 1, op: 'so_to_do', docType: 'DO', docNo: 'HC-DO-1', docId: 'do-1',
      from: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-1' },
      to: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
    });
    const row = outbox(sb)[0];
    expect(row.status).toBe('pending');
    expect(acNeedsAttention(row.status, row.last_error)).toBe(false);
    expect(row.last_error).toContain('DocDate');
    expect(row.last_error).toContain('Ref');
    expect(row.last_error).toContain('the ERP document has none');
    expect(row.payload.notCarried).toEqual(expect.arrayContaining([
      expect.stringContaining('DocDate'),
      expect.stringContaining('Ref'),
    ]));
  });

  test('a document carrying everything says nothing — no reason, no noise', async () => {
    const sb = withFlag('1', {
      delivery_orders: [{
        id: 'do-1', do_number: 'HC-DO-1', do_date: '2026-08-19',
        debtor_name: 'Trial Customer', ref: 'CUST-9', phone: '011', note: 'Back gate',
        linked_ac_docno: null,
      }],
      delivery_order_items: [],
    });
    await enqueueConvert(client(sb), {
      companyId: 1, op: 'so_to_do', docType: 'DO', docNo: 'HC-DO-1', docId: 'do-1',
      from: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-1' },
      to: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
    });
    const row = outbox(sb)[0];
    expect(row.last_error).toBeNull();
    expect(row.payload.notCarried).toBeUndefined();
    const body = row.payload.body as Record<string, unknown>;
    expect(body.DocDate).toBe('2026-08-19');
    expect(body.Ref).toBe('CUST-9');
    expect(body.DebtorName).toBe('Trial Customer');
    expect(body.Note).toBe('Back gate');
  });

  test('a header read that fails still queues the transfer, and says why it is bare', async () => {
    const sb = withFlag('1', {
      delivery_orders: [],
    });
    expect((await enqueueConvert(client(sb), {
      companyId: 1, op: 'so_to_do', docType: 'DO', docNo: 'HC-DO-1', docId: 'do-1',
      from: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-1' },
      to: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
    })).queued).toBe(true);
    const row = outbox(sb)[0];
    expect(row.status).toBe('pending');
    expect(row.payload.body.DocNo).toBe('HC-DO-1');
    expect(row.last_error).toContain('not found');
  });
});

describe('an enqueue that refuses says so to the operator, not only to the queue', () => {
  const po = {
    id: 'po-1', po_number: 'HC-PO-9', po_date: '2026-08-10',
    supplier_id: 'sup-1', notes: null, linked_ac_docno: null,
  };
  const poItem = (item: string) => ({
    purchase_order_id: 'po-1', item_code: item, description: 'D',
    qty: 1, unit_price_sen: 5000, warehouse_id: 'wh-1',
  });
  const warehouses = [{ id: 'wh-1', code: 'KL', name: 'KL WAREHOUSE' }];

  test('a supplier with no AutoCount creditor code — skipped row AND a sentence', async () => {
    const sb = withFlag('1', {
      purchase_orders: [{ ...po }],
      suppliers: [{ id: 'sup-1', code: null, name: 'Supplier' }],
      purchase_order_items: [poItem(ERP_A)],
      warehouses,
    });
    const out = await enqueuePoCreate(sb as never, { companyId: 1, poId: 'po-1' });
    expect(out.queued).toBe(false);
    const rows = outbox(sb);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('skipped');
    expect(String(rows[0].last_error)).toContain('MissingCreditorError');
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0].message).toContain('has NOT reached the accounts');
    expect(out.problems[0].message).toContain('Ask accounts');
    expect(out.problems[0].message).not.toContain('HC-PO-9');
  });

  test('a line the accounts hold under two items, for a creditor that owns neither', async () => {
    const sb = withFlag('1', {
      purchase_orders: [{ ...po }],
      suppliers: [{ id: 'sup-1', code: '400-H004', name: 'Supplier' }],
      purchase_order_items: [poItem('9028-1S')],
      warehouses,
    });
    const out = await enqueuePoCreate(sb as never, { companyId: 1, poId: 'po-1' });
    expect(out.queued).toBe(false);
    expect(outbox(sb)[0].status).toBe('skipped');
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0].line).toBe('9028-1S');
    expect(out.problems[0].message).toContain('retired');
  });

  test('CONTROL — a PO the composer accepts queues and says NOTHING', async () => {
    const sb = withFlag('1', {
      purchase_orders: [{ ...po }],
      suppliers: [{ id: 'sup-1', code: '400-H004', name: 'Supplier' }],
      purchase_order_items: [poItem(ERP_A)],
      warehouses,
    });
    const out = await enqueuePoCreate(sb as never, { companyId: 1, poId: 'po-1' });
    expect(out.queued).toBe(true);
    expect(out.problems).toEqual([]);
  });

  test('CONTROL — the flag OFF is not a refusal and must not warn anyone', async () => {
    const sb = withFlag('off', {
      purchase_orders: [{ ...po }],
      suppliers: [{ id: 'sup-1', code: null, name: 'Supplier' }],
      purchase_order_items: [poItem(ERP_A)],
      warehouses,
    });
    const out = await enqueuePoCreate(sb as never, { companyId: 1, poId: 'po-1' });
    expect(out.queued).toBe(false);
    expect(out.problems).toEqual([]);
    expect(outbox(sb)).toHaveLength(0);
  });

  test('CONTROL — a cutover-imported PO is already in the book, and says nothing', async () => {
    const sb = withFlag('1', {
      purchase_orders: [{ ...po, linked_ac_docno: 'PO-000123' }],
      suppliers: [{ id: 'sup-1', code: null, name: 'Supplier' }],
      purchase_order_items: [poItem(ERP_A)],
      warehouses,
    });
    const out = await enqueuePoCreate(sb as never, { companyId: 1, poId: 'po-1' });
    expect(out.queued).toBe(false);
    expect(out.problems).toEqual([]);
  });
});
