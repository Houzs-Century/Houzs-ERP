import { describe, expect, test, beforeEach } from 'vitest';
import { enqueueConvert } from './autocount-outbox';
import { resetWritebackFlagCache } from './autocount-writeback-flag';
import { fakeSb, type Row } from './fake-postgrest';

const SALESPERSON = { id: 'staff-1', name: 'Nurul Hidayah' };

const withFlag = (value: string | null, extra: Record<string, Row[]> = {}) =>
  fakeSb({
    app_config: value == null ? [] : [{ key: 'scm.autocount_writeback', value }],
    autocount_outbox: [],
    staff: [{ ...SALESPERSON }],
    mfg_sales_orders: [
      { doc_no: 'HC-SO-9', company_id: 1, salesperson_id: SALESPERSON.id, sales_location: 'KL' },
      { doc_no: 'HC-SO-10', company_id: 1, salesperson_id: SALESPERSON.id, sales_location: 'KL' },
    ],
    delivery_orders: [{ id: 'do-1', linked_ac_docno: null }],
    ...extra,
  });

const outbox = (sb: { tables: Record<string, Row[]> }) => sb.tables.autocount_outbox ?? [];

beforeEach(() => resetWritebackFlagCache());

describe('a partial conversion transfers only the lines it actually took', () => {
  const soLines = (keys: Array<number | null>) => keys.map((k, i) => ({
    id: `so-item-${i + 1}`, doc_no: 'HC-SO-9', item_code: `SKU-${i + 1}`,
    qty: 1, unit_price_sen: 100, linked_ac_dtlkey: k, cancelled: false,
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
    expect((await convertDo(sb)).queued).toBe(true);
    const [row] = outbox(sb);
    expect(row.status).toBe('pending');
    expect(row.payload.body.DtlKeys).toEqual([9001, 9002]);
    expect(row.payload.body.DtlKeys).not.toContain(9003);
  });

  test('a PARTIAL transfer whose source line has no key is REFUSED, not sent blind', async () => {
    const sb = withFlag('1', {
      mfg_sales_order_items: soLines([9001, null, 9003]),
      delivery_order_items: [
        { id: 'do-item-1', delivery_order_id: 'do-1', so_item_id: 'so-item-1', item_code: 'SKU-1' },
        { id: 'do-item-2', delivery_order_id: 'do-1', so_item_id: 'so-item-2', item_code: 'SKU-2' },
      ],
    });
    expect((await convertDo(sb)).queued).toBe(false);
    const [row] = outbox(sb);
    expect(row.status).toBe('skipped');
    expect(row.last_error).toContain('cannot name the subset');
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
    expect((await convertDo(sb)).queued).toBe(true);
    const [row] = outbox(sb);
    expect(row.status).toBe('pending');
    expect(row.payload.body.DtlKeys).toBeUndefined();
  });

  test('a cancelled parent line is not a line this conversion left behind', async () => {
    const sb = withFlag('1', {
      mfg_sales_order_items: [
        ...soLines([9001, 9002]),
        {
          id: 'so-item-3', doc_no: 'HC-SO-9', item_code: 'SKU-3', qty: 1,
          unit_price_sen: 100, linked_ac_dtlkey: null, cancelled: true,
        },
      ],
      delivery_order_items: [
        { id: 'do-item-1', delivery_order_id: 'do-1', so_item_id: 'so-item-1', item_code: 'SKU-1' },
        { id: 'do-item-2', delivery_order_id: 'do-1', so_item_id: 'so-item-2', item_code: 'SKU-2' },
      ],
    });
    expect((await convertDo(sb)).queued).toBe(true);
    const [row] = outbox(sb);
    expect(row.payload.body.DtlKeys).toEqual([9001, 9002]);
  });

  test('a MERGE that leaves one parent line behind is partial, and an unnameable subset is REFUSED', async () => {
    const sb = withFlag('1', {
      mfg_sales_order_items: [
        { id: 'a-1', doc_no: 'HC-SO-9', item_code: 'SKU-1', qty: 1, unit_price_sen: 100, linked_ac_dtlkey: 9001, cancelled: false },
        { id: 'a-2', doc_no: 'HC-SO-9', item_code: 'SKU-2', qty: 1, unit_price_sen: 100, linked_ac_dtlkey: 9002, cancelled: false },
        { id: 'b-1', doc_no: 'HC-SO-10', item_code: 'SKU-3', qty: 1, unit_price_sen: 100, linked_ac_dtlkey: null, cancelled: false },
        { id: 'b-2', doc_no: 'HC-SO-10', item_code: 'SKU-4', qty: 1, unit_price_sen: 100, linked_ac_dtlkey: 9004, cancelled: false },
      ],
      delivery_order_items: [
        { id: 'do-item-1', delivery_order_id: 'do-1', so_item_id: 'a-1', item_code: 'SKU-1' },
        { id: 'do-item-2', delivery_order_id: 'do-1', so_item_id: 'a-2', item_code: 'SKU-2' },
        { id: 'do-item-3', delivery_order_id: 'do-1', so_item_id: 'b-1', item_code: 'SKU-3' },
      ],
    });
    expect((await enqueueConvert(sb as never, {
      companyId: 1,
      op: 'so_to_do',
      from: [
        { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
        { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-10' },
      ],
      to: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
      docType: 'DO',
      docNo: 'HC-DO-1',
      docId: 'do-1',
    })).queued).toBe(false);
    const [row] = outbox(sb);
    expect(row.status).toBe('skipped');
    expect(row.last_error).toContain('cannot name the subset');
    expect(outbox(sb).filter((r) => r.status === 'pending')).toHaveLength(0);
  });

  test('a merge that takes EVERY line of every parent still sends the keys it named', async () => {
    const sb = withFlag('1', {
      mfg_sales_order_items: [
        { id: 'a-1', doc_no: 'HC-SO-9', item_code: 'SKU-1', qty: 1, unit_price_sen: 100, linked_ac_dtlkey: 9001, cancelled: false },
        { id: 'b-1', doc_no: 'HC-SO-10', item_code: 'SKU-3', qty: 1, unit_price_sen: 100, linked_ac_dtlkey: 9003, cancelled: false },
      ],
      delivery_order_items: [
        { id: 'do-item-1', delivery_order_id: 'do-1', so_item_id: 'a-1', item_code: 'SKU-1' },
        { id: 'do-item-2', delivery_order_id: 'do-1', so_item_id: 'b-1', item_code: 'SKU-3' },
      ],
    });
    expect((await enqueueConvert(sb as never, {
      companyId: 1,
      op: 'so_to_do',
      from: [
        { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
        { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-10' },
      ],
      to: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
      docType: 'DO',
      docNo: 'HC-DO-1',
      docId: 'do-1',
    })).queued).toBe(true);
    const [row] = outbox(sb);
    expect(row.status).toBe('pending');
    expect(row.payload.body.DtlKeys).toEqual([9001, 9003]);
    expect(row.payload.fromDocs?.map((r: { key: string }) => r.key)).toEqual(['HC-SO-9', 'HC-SO-10']);
  });

  test('a DO shipping 2 of a 5-unit line names the QUANTITY, not just the line', async () => {
    const sb = withFlag('1', {
      mfg_sales_order_items: [
        { id: 'so-1', doc_no: 'HC-SO-9', item_code: 'SKU-1', qty: 5, unit_price_sen: 100, linked_ac_dtlkey: 9001, cancelled: false },
      ],
      delivery_order_items: [
        { id: 'do-item-1', delivery_order_id: 'do-1', so_item_id: 'so-1', item_code: 'SKU-1', qty: 2 },
      ],
    });
    expect((await enqueueConvert(sb as never, {
      companyId: 1,
      op: 'so_to_do',
      from: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
      to: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
      docType: 'DO', docNo: 'HC-DO-1', docId: 'do-1',
    })).queued).toBe(true);
    const [row] = outbox(sb);
    expect(row.status).toBe('pending');
    expect(row.payload.body.DtlKeys).toEqual([9001]);
    expect(row.payload.body.Details).toEqual([{ DtlKey: 9001, Qty: 2 }]);
  });

  test('a DO shipping the WHOLE line sends no quantity at all', async () => {
    const sb = withFlag('1', {
      mfg_sales_order_items: [
        { id: 'so-1', doc_no: 'HC-SO-9', item_code: 'SKU-1', qty: 5, unit_price_sen: 100, linked_ac_dtlkey: 9001, cancelled: false },
      ],
      delivery_order_items: [
        { id: 'do-item-1', delivery_order_id: 'do-1', so_item_id: 'so-1', item_code: 'SKU-1', qty: 5 },
      ],
    });
    expect((await enqueueConvert(sb as never, {
      companyId: 1,
      op: 'so_to_do',
      from: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
      to: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
      docType: 'DO', docNo: 'HC-DO-1', docId: 'do-1',
    })).queued).toBe(true);
    const [row] = outbox(sb);
    expect(row.payload.body.DtlKeys).toEqual([9001]);
    expect(row.payload.body.Details).toBeUndefined();
  });

  test('one partial line makes EVERY named line carry a quantity', async () => {
    const sb = withFlag('1', {
      mfg_sales_order_items: [
        { id: 'so-1', doc_no: 'HC-SO-9', item_code: 'SKU-1', qty: 5, unit_price_sen: 100, linked_ac_dtlkey: 9001, cancelled: false },
        { id: 'so-2', doc_no: 'HC-SO-9', item_code: 'SKU-2', qty: 3, unit_price_sen: 100, linked_ac_dtlkey: 9002, cancelled: false },
      ],
      delivery_order_items: [
        { id: 'do-item-1', delivery_order_id: 'do-1', so_item_id: 'so-1', item_code: 'SKU-1', qty: 2 },
        { id: 'do-item-2', delivery_order_id: 'do-1', so_item_id: 'so-2', item_code: 'SKU-2', qty: 3 },
      ],
    });
    expect((await enqueueConvert(sb as never, {
      companyId: 1,
      op: 'so_to_do',
      from: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
      to: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
      docType: 'DO', docNo: 'HC-DO-1', docId: 'do-1',
    })).queued).toBe(true);
    const [row] = outbox(sb);
    expect(row.payload.body.Details).toEqual([
      { DtlKey: 9001, Qty: 2 },
      { DtlKey: 9002, Qty: 3 },
    ]);
    expect(row.payload.body.Details.length).toBe(row.payload.body.DtlKeys.length);
  });

  test('a DO built entirely of ad-hoc lines queues the conversion unchanged', async () => {
    const sb = withFlag('1', {
      mfg_sales_order_items: soLines([9001]),
      delivery_order_items: [
        { id: 'do-item-1', delivery_order_id: 'do-1', so_item_id: null, item_code: 'ADHOC' },
      ],
    });
    expect((await convertDo(sb)).queued).toBe(true);
    const [row] = outbox(sb);
    expect(row.status).toBe('pending');
    expect(row.payload.body.DtlKeys).toBeUndefined();
  });
});

describe('several ERP lines sharing one book line', () => {
  const convertDo = (sb: unknown) => enqueueConvert(sb as never, {
    companyId: 1,
    op: 'so_to_do',
    from: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
    to: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
    docType: 'DO',
    docNo: 'HC-DO-1',
    docId: 'do-1',
  });

  const sofaSo = (pieceQty = 1) => [
    { id: 'so-1', doc_no: 'HC-SO-9', item_code: 'HOK-5535 SOFA', qty: pieceQty, unit_price_sen: 100, linked_ac_dtlkey: 901830, cancelled: false },
    { id: 'so-2', doc_no: 'HC-SO-9', item_code: 'HOK-5535 SOFA', qty: pieceQty, unit_price_sen: 100, linked_ac_dtlkey: 901830, cancelled: false },
    { id: 'so-3', doc_no: 'HC-SO-9', item_code: 'HOK-LONG PILLOW', qty: 3, unit_price_sen: 100, linked_ac_dtlkey: 901831, cancelled: false },
  ];

  test('the shared key is sent ONCE, not once per piece', async () => {
    const sb = withFlag('1', {
      mfg_sales_order_items: sofaSo(),
      delivery_order_items: [
        { id: 'd1', delivery_order_id: 'do-1', so_item_id: 'so-1', item_code: 'HOK-5535 SOFA', qty: 1 },
        { id: 'd2', delivery_order_id: 'do-1', so_item_id: 'so-2', item_code: 'HOK-5535 SOFA', qty: 1 },
        { id: 'd3', delivery_order_id: 'do-1', so_item_id: 'so-3', item_code: 'HOK-LONG PILLOW', qty: 3 },
      ],
    });
    expect((await convertDo(sb)).queued).toBe(true);
    const [row] = outbox(sb);
    expect(row.status).toBe('pending');
    expect(row.payload.body.DtlKeys).toEqual([901830, 901831]);
  });

  test('no quantity rides with a shared key, so the piece count cannot over-transfer', async () => {
    const sb = withFlag('1', {
      mfg_sales_order_items: sofaSo(),
      delivery_order_items: [
        { id: 'd1', delivery_order_id: 'do-1', so_item_id: 'so-1', item_code: 'HOK-5535 SOFA', qty: 1 },
        { id: 'd2', delivery_order_id: 'do-1', so_item_id: 'so-2', item_code: 'HOK-5535 SOFA', qty: 1 },
        { id: 'd3', delivery_order_id: 'do-1', so_item_id: 'so-3', item_code: 'HOK-LONG PILLOW', qty: 3 },
      ],
    });
    await convertDo(sb);
    const [row] = outbox(sb);
    expect(row.payload.body.Details).toBeUndefined();
  });

  test('the sofa WAITS and the pillow goes on time', async () => {
    const sb = withFlag('1', {
      mfg_sales_order_items: sofaSo(),
      delivery_order_items: [
        { id: 'd1', delivery_order_id: 'do-1', so_item_id: 'so-1', item_code: 'HOK-5535 SOFA', qty: 1 },
        { id: 'd3', delivery_order_id: 'do-1', so_item_id: 'so-3', item_code: 'HOK-LONG PILLOW', qty: 3 },
      ],
    });
    expect((await convertDo(sb)).queued).toBe(true);
    const [row] = outbox(sb);
    expect(row.status).toBe('pending');
    expect(row.payload.body.DtlKeys).toEqual([901831]);
  });

  /* 「C 除了accessories 不看 就看sofa」 — the pillow is a different key and a
     different question, so it never enters the sofa's decision. */
  test('an undelivered ACCESSORY does not hold the sofa back', async () => {
    const sb = withFlag('1', {
      mfg_sales_order_items: sofaSo(),
      delivery_order_items: [
        { id: 'd1', delivery_order_id: 'do-1', so_item_id: 'so-1', item_code: 'HOK-5535 SOFA', qty: 1 },
        { id: 'd2', delivery_order_id: 'do-1', so_item_id: 'so-2', item_code: 'HOK-5535 SOFA', qty: 1 },
      ],
    });
    expect((await convertDo(sb)).queued).toBe(true);
    const [row] = outbox(sb);
    expect(row.payload.body.DtlKeys).toEqual([901830]);
  });

  test('the delivery that covers the LAST piece carries the sofa', async () => {
    const sb = withFlag('1', {
      mfg_sales_order_items: sofaSo(),
      delivery_order_items: [
        { id: 'd0', delivery_order_id: 'do-0', so_item_id: 'so-1', item_code: 'HOK-5535 SOFA', qty: 1 },
        { id: 'd2', delivery_order_id: 'do-1', so_item_id: 'so-2', item_code: 'HOK-5535 SOFA', qty: 1 },
      ],
    });
    expect((await convertDo(sb)).queued).toBe(true);
    const [row] = outbox(sb);
    expect(row.payload.body.DtlKeys).toEqual([901830]);
    expect(row.payload.body.Details).toBeUndefined();
  });

  test('a document that is ONLY an incomplete sofa is refused, not sent empty', async () => {
    const sb = withFlag('1', {
      mfg_sales_order_items: sofaSo(),
      delivery_order_items: [
        { id: 'd1', delivery_order_id: 'do-1', so_item_id: 'so-1', item_code: 'HOK-5535 SOFA', qty: 1 },
      ],
    });
    expect((await convertDo(sb)).queued).toBe(false);
    const [row] = outbox(sb);
    expect(row.status).toBe('skipped');
    expect(row.last_error).toContain('waits for the delivery that completes it');
    expect(outbox(sb).filter((r) => r.status === 'pending')).toHaveLength(0);
  });

  test('a document with no shared key still sends quantities on a real partial', async () => {
    const sb = withFlag('1', {
      mfg_sales_order_items: [
        { id: 'so-1', doc_no: 'HC-SO-9', item_code: 'SKU-1', qty: 5, unit_price_sen: 100, linked_ac_dtlkey: 7001, cancelled: false },
      ],
      delivery_order_items: [
        { id: 'd1', delivery_order_id: 'do-1', so_item_id: 'so-1', item_code: 'SKU-1', qty: 2 },
      ],
    });
    await convertDo(sb);
    const [row] = outbox(sb);
    expect(row.payload.body.DtlKeys).toEqual([7001]);
    expect(row.payload.body.Details).toEqual([{ DtlKey: 7001, Qty: 2 }]);
  });
});
