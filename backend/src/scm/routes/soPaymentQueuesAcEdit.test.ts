import { beforeEach, describe, expect, test } from 'vitest';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import { resetWritebackFlagCache } from '../lib/autocount-writeback-flag';
import { recordSoPaymentRow } from '../lib/so-payment-row';
import { composeSoPaymentEdit } from '../lib/ac-so-payment-edit';
import { todayMyt } from '../lib/my-time';

beforeEach(() => resetWritebackFlagCache());

const ERP_ITEM = 'AKEMI APEX MATT (SP)';

const SO = {
  doc_no: 'HC-SO-P1', so_date: '2026-08-15', debtor_name: 'ACME', company_id: 1,
  agent: null, salesperson_id: 'staff-1',
  sales_location: 'KL WAREHOUSE', branding: null, venue: null,
  address1: 'A1', address2: null, address3: null, address4: null,
  city: null, postcode: null, customer_state: null,
  phone: '012-1111111', emergency_contact_phone: null,
  ref: null, po_doc_no: null, customer_po: null, customer_so_no: null,
  processing_date: null,
  total_revenue_sen: 500_00, balance_sen: 500_00, deposit_sen: 0,
  linked_ac_docno: 'SO-000021',
};

const ITEM = {
  doc_no: 'HC-SO-P1', item_code: ERP_ITEM, description: 'Mattress',
  qty: 1, unit_price_sen: 500_00, line_delivery_date: null,
  linked_ac_dtlkey: 991,
};

const seed = (flag: string | null, soOver: Row = {}, extra: Record<string, Row[]> = {}) =>
  fakeSb({
    app_config: flag == null ? [] : [{ key: 'scm.autocount_writeback', value: flag }],
    autocount_outbox: [],
    staff: [{ id: 'staff-1', name: 'Nurul Hidayah' }],
    mfg_sales_orders: [{ ...SO, ...soOver }],
    mfg_sales_order_items: [{ ...ITEM }],
    mfg_sales_order_payments: [],
    so_audit_log: [],
    ...extra,
  });

const outbox = (sb: { tables: Record<string, Row[]> }) => sb.tables.autocount_outbox ?? [];

const payment = (over: Row = {}) => ({
  docNo: 'HC-SO-P1',
  paidAt: todayMyt(),
  method: 'cash' as const,
  amountSen: 300_00,
  slipKey: 'slips/ac.jpg',
  createdBy: '00000000-0000-4000-8000-000000000001',
  ...over,
});

describe('a recorded payment queues the AutoCount edit that carries the new balance', () => {
  test('the ledger row and an edit operation both land', async () => {
    const sb = seed('1');
    const { payment: row, errorMessage } = await recordSoPaymentRow(sb, payment());

    expect(errorMessage).toBeNull();
    expect(row).not.toBeNull();

    const queued = outbox(sb);
    expect(queued).toHaveLength(1);
    expect(queued[0].op).toBe('edit');
    expect(queued[0].doc_type).toBe('SO');
    expect(queued[0].doc_no).toBe('HC-SO-P1');
  });

  test('the queued edit carries the balance AFTER this payment, not before it', async () => {
    const sb = seed('1');
    await recordSoPaymentRow(sb, payment());

    const header = outbox(sb)[0].payload.body.Header as Record<string, Record<string, string>>;
    expect(header.UDF.BALANCE).toBe('200.00');
  });

  test('a payment that settles the order sends 0.00', async () => {
    const sb = seed('1');
    await recordSoPaymentRow(sb, payment({ amountSen: 500_00 }));

    const header = outbox(sb)[0].payload.body.Header as Record<string, Record<string, string>>;
    expect(header.UDF.BALANCE).toBe('0.00');
  });

  test('the write-back toggle OFF queues nothing, and the payment still records', async () => {
    const sb = seed('off');
    const { errorMessage } = await recordSoPaymentRow(sb, payment());

    expect(errorMessage).toBeNull();
    expect(sb.tables.mfg_sales_order_payments).toHaveLength(1);
    expect(outbox(sb)).toHaveLength(0);
  });

  test('an order with no AutoCount counterpart queues nothing', async () => {
    const sb = seed('1', { linked_ac_docno: null });
    await recordSoPaymentRow(sb, payment());

    expect(sb.tables.mfg_sales_order_payments).toHaveLength(1);
    expect(outbox(sb)).toHaveLength(0);
  });

  test('a queue that cannot be written does not fail the payment', async () => {
    const sb = fakeSb({
      app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
      staff: [{ id: 'staff-1', name: 'Nurul Hidayah' }],
      mfg_sales_orders: [{ ...SO }],
      mfg_sales_order_items: [{ ...ITEM }],
      mfg_sales_order_payments: [],
      so_audit_log: [],
      autocount_outbox: [],
    }, { autocount_outbox: ['payload'] });

    const { payment: row, errorMessage } = await recordSoPaymentRow(sb, payment());
    expect(errorMessage).toBeNull();
    expect(row).not.toBeNull();
  });
});

/* docs/bugs/0896. A payment moves two header fields and no line, so it sends
   those two and nothing else — composing the lines is where an edit is refused,
   and the drain attaches every line photograph to an edit that carries lines.
   The host's Edit() leaves every line alone when `Lines` is empty and `Rebuild`
   is absent (AcSyncService.cs, the pre-flight and line loops run over `Lines`). */
describe('a payment sends only the balance and the references', () => {
  test('the body is header-only: the two UDFs, an empty line list, no rebuild, no photographs', async () => {
    const sb = seed('1', { linked_ac_docno: 'HC-SO-P1' }, {
      mfg_sales_order_items: [{ ...ITEM, photo_urls: ['so-items/HC-SO-P1/a.jpg'] }],
    });
    await recordSoPaymentRow(sb, payment({ accountSheet: 'MAYBANK', approvalCode: '111' }));

    const row = outbox(sb)[0];
    expect(row.status).toBe('pending');
    expect(row.payload.body).toEqual({
      DocType: 'SO',
      DocNo: 'HC-SO-P1',
      Header: { UDF: { BALANCE: '200.00', PAYEMENT: '(MAYBANK/111)' } },
      Lines: [],
    });
    expect(row.payload.photos).toBeUndefined();
  });

  test('a line with no AutoCount key no longer holds the payment back', async () => {
    const sb = seed('1', {}, { mfg_sales_order_items: [{ ...ITEM, linked_ac_dtlkey: null }] });
    await recordSoPaymentRow(sb, payment());

    const queued = outbox(sb);
    expect(queued).toHaveLength(1);
    expect(queued[0].status).toBe('pending');
    expect(queued[0].last_error ?? null).toBeNull();
    expect((queued[0].payload.body.Header as { UDF: Record<string, string> }).UDF.BALANCE).toBe('200.00');
  });

  test('an order still waiting for its create folds the payment into the create, as before', async () => {
    const sb = seed('1', { linked_ac_docno: null }, {
      autocount_outbox: [{
        id: 'create-1', company_id: 1, op: 'create_so', doc_type: 'SO', doc_no: 'HC-SO-P1',
        status: 'pending', payload: { body: { DocNo: 'HC-SO-P1' } }, created_at: '2026-09-14T00:00:00Z',
      }],
    });
    await recordSoPaymentRow(sb, payment());

    const queued = outbox(sb);
    expect(queued).toHaveLength(1);
    expect(queued[0].op).toBe('create_so');
    expect((queued[0].payload.body as { UDF?: Record<string, string> }).UDF?.BALANCE).toBe('200.00');
  });
});

describe('composeSoPaymentEdit', () => {
  test('a settled order sends 0.00, and no reference omits PAYEMENT', () => {
    expect(composeSoPaymentEdit('SO-1', 0, [{ account_sheet: null, approval_code: null }]))
      .toEqual({ DocType: 'SO', DocNo: 'SO-1', Header: { UDF: { BALANCE: '0.00' } }, Lines: [] });
  });

  test('no total to compute a balance from and no reference: nothing to send', () => {
    expect(composeSoPaymentEdit('SO-1', null, [])).toBeNull();
  });

  test('references alone still travel when the balance is unknown', () => {
    expect(composeSoPaymentEdit('SO-1', null, [{ account_sheet: 'Cash', approval_code: null }]))
      .toEqual({ DocType: 'SO', DocNo: 'SO-1', Header: { UDF: { PAYEMENT: '(Cash/)' } }, Lines: [] });
  });
});
