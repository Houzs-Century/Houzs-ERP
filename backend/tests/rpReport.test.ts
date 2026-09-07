/* The Receipts & Payments report (owner 2026-09-06/07). Pinned:
     • money accounts are the columns, opening = posted movements before the
       period, closing = opening + receipts − payments, per column;
     • rows are the OTHER side, in the owner's own accounts — a customer
       collection reads as the AR control, an expense voucher as its account;
     • a SUPPLIER payment reads through what it settled (rule A): a PI's own
       purchase groups in the PI's proportion, an AP invoice's own lines, and
       what it paid beyond that as "Supplier advances";
     • a transfer between two money accounts reads as Transfer to/from;
     • party=1 names the control rows by debtor/creditor and does not split;
     • reversed journals are invisible; an account filter narrows the columns.
   Real handler, fake PostgREST (fakeSb). */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { receiptsPaymentsReport } from '../src/scm/routes/accounting-rp';

const CO = 2;
let lineId = 0;
const gl = (jeNo: string, date: string, source: string, doc: string | null, code: string, name: string, dr: number, cr: number, extra: Row = {}): Row => ({
  line_id: ++lineId, company_id: CO, je_no: jeNo, entry_date: date, source_type: source, source_doc_no: doc,
  account_code: code, account_name: name, debit_sen: dr, credit_sen: cr, party_type: null, party_name: null, notes: null,
  posted: true, reversed: false, ...extra,
});

const world = () => fakeSb({
  accounts: [
    { company_id: CO, account_code: '310-0010', account_name: 'CASH AT BANK - MAYBANK', acc_money: true, is_active: true },
    { company_id: CO, account_code: '320-0000', account_name: 'CASH IN HAND', acc_money: true, is_active: true },
    { company_id: CO, account_code: '300-0000', account_name: 'ACCOUNT RECEIVEABLE', acc_money: false, is_active: true },
    { company_id: CO, account_code: '400-0000', account_name: 'ACCOUNT PAYABLE', acc_money: false, is_active: true },
    { company_id: CO, account_code: '405-0000', account_name: 'OTHER CREDITORS', acc_money: false, is_active: true },
    { company_id: CO, account_code: '900-A001', account_name: 'RENTAL', acc_money: false, is_active: true },
    { company_id: CO, account_code: '910-0000', account_name: 'UTILITIES', acc_money: false, is_active: true },
    { company_id: CO, account_code: '601-0003', account_name: 'PURCHASE OF SOFA', acc_money: false, is_active: true },
    { company_id: CO, account_code: '601-0001', account_name: 'PURCHASE OF BEDDING', acc_money: false, is_active: true },
  ],
  acc_account_roles: [],
  v_gl_entries: [
    /* Before the period: an expense paid from the bank → opening −100.00 */
    gl('JE-0', '2026-06-30', 'PV', 'PV-0', '900-A001', 'RENTAL', 10000, 0),
    gl('JE-0', '2026-06-30', 'PV', 'PV-0', '310-0010', 'CASH AT BANK - MAYBANK', 0, 10000),
    /* A customer collection into the bank. */
    gl('JE-1', '2026-07-05', 'SOPAY', 'pay-1', '310-0010', 'CASH AT BANK - MAYBANK', 50000, 0),
    gl('JE-1', '2026-07-05', 'SOPAY', 'pay-1', '300-0000', 'ACCOUNT RECEIVEABLE', 0, 50000, { party_type: 'CUSTOMER', party_name: 'Ah Meng' }),
    /* An expense voucher from the drawer. */
    gl('JE-2', '2026-07-10', 'PV', 'PV-2', '910-0000', 'UTILITIES', 6000, 0),
    gl('JE-2', '2026-07-10', 'PV', 'PV-2', '320-0000', 'CASH IN HAND', 0, 6000),
    /* A supplier payment: 1,000 to the trade creditor, settling PI-1 (700) and 300 ahead. */
    gl('JE-3', '2026-07-15', 'PV', 'PV-3', '400-0000', 'ACCOUNT PAYABLE', 100000, 0, { party_type: 'SUPPLIER', party_name: 'FOSHAN CHAIRS' }),
    gl('JE-3', '2026-07-15', 'PV', 'PV-3', '310-0010', 'CASH AT BANK - MAYBANK', 0, 100000),
    /* PI-1's own journal (June): sofa 400 + bedding 300 / AP 700. */
    gl('JE-PI', '2026-06-20', 'PI', 'PI-1', '601-0003', 'PURCHASE OF SOFA', 40000, 0),
    gl('JE-PI', '2026-06-20', 'PI', 'PI-1', '601-0001', 'PURCHASE OF BEDDING', 30000, 0),
    gl('JE-PI', '2026-06-20', 'PI', 'PI-1', '400-0000', 'ACCOUNT PAYABLE', 0, 70000),
    /* A transfer bank → drawer. */
    gl('JE-4', '2026-07-20', 'MANUAL', null, '320-0000', 'CASH IN HAND', 20000, 0),
    gl('JE-4', '2026-07-20', 'MANUAL', null, '310-0010', 'CASH AT BANK - MAYBANK', 0, 20000),
    /* An AP-invoice payment: 50 to the other creditor for a rent bill. */
    gl('JE-5', '2026-07-25', 'PV', 'PV-5', '405-0000', 'OTHER CREDITORS', 5000, 0, { party_type: 'SUPPLIER', party_name: 'HOUZS VENTURE' }),
    gl('JE-5', '2026-07-25', 'PV', 'PV-5', '310-0010', 'CASH AT BANK - MAYBANK', 0, 5000),
    /* A reversed voucher — invisible. */
    gl('JE-9', '2026-07-26', 'PV', 'PV-9', '910-0000', 'UTILITIES', 99900, 0, { reversed: true }),
    gl('JE-9', '2026-07-26', 'PV', 'PV-9', '310-0010', 'CASH AT BANK - MAYBANK', 0, 99900, { reversed: true }),
  ],
  payment_vouchers: [
    { id: 'pv-3', company_id: CO, pv_number: 'PV-3', status: 'POSTED' },
    { id: 'pv-5', company_id: CO, pv_number: 'PV-5', status: 'POSTED' },
  ],
  pv_allocations: [
    { id: 'al-3', company_id: CO, pv_id: 'pv-3', pi_id: 'pi-1', ap_invoice_id: null, amount_sen: 70000, applied_sen: 70000, from_advance: false },
    { id: 'al-5', company_id: CO, pv_id: 'pv-5', pi_id: null, ap_invoice_id: 'api-1', amount_sen: 5000, applied_sen: 5000, from_advance: false },
  ],
  purchase_invoices: [{ id: 'pi-1', company_id: CO, invoice_number: 'PI-1' }],
  ap_invoices: [{ id: 'api-1', company_id: CO, invoice_number: 'API-1' }],
  ap_invoice_lines: [{ id: 'l1', company_id: CO, invoice_id: 'api-1', debit_account_code: '900-A001', amount_sen: 5000 }],
});

function harness(sb: ReturnType<typeof fakeSb>) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: ['scm.payment_voucher.post'] } as never);
    await next();
  });
  app.get('/accounting/reports/receipts-payments', receiptsPaymentsReport as never);
  return app;
}
type Report = {
  columns: Array<{ code: string; name: string }>; opening: Record<string, number>;
  receipts: Array<{ key: string; code: string | null; name: string; cells: Record<string, number>; totalSen: number }>;
  payments: Array<{ key: string; code: string | null; name: string; cells: Record<string, number>; totalSen: number }>;
  totals: { receipts: Record<string, number>; payments: Record<string, number>; closing: Record<string, number>; openingTotalSen: number; receiptsTotalSen: number; paymentsTotalSen: number; closingTotalSen: number };
  entries: Array<{ jeNo: string; side: 'R' | 'P'; rowKey: string; column: string; sen: number }>;
};
const fetchReport = async (app: Hono, qs: string): Promise<Report> => {
  const res = await app.request(`/accounting/reports/receipts-payments?${qs}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return await res.json() as Report;
};
const cell = (rows: Report['receipts'], key: string, col: string) => rows.find((r) => r.key === key)?.cells[col] ?? 0;

describe('Receipts & Payments — columns per money account, rows in the owner\'s accounts', () => {
  test('opening, the period, closing — and a supplier payment read through what it settled (rule A)', async () => {
    const r = await fetchReport(harness(world()), 'from=2026-07-01&to=2026-07-31');
    expect(r.columns.map((c) => c.code)).toEqual(['310-0010', '320-0000']);
    expect(r.opening).toEqual({ '310-0010': -10000, '320-0000': 0 });

    /* Receipts: the collection on AR into the bank; the transfer into the drawer. */
    expect(cell(r.receipts, '300-0000', '310-0010')).toBe(50000);
    expect(cell(r.receipts, 'XFER:310-0010', '320-0000')).toBe(20000);
    /* Payments: utilities from the drawer; the supplier payment split by PI-1's own
       groups (700 → sofa 400 / bedding 300) plus 300 paid ahead; the AP bill's rent;
       the transfer out of the bank. */
    expect(cell(r.payments, '910-0000', '320-0000')).toBe(6000);
    expect(cell(r.payments, '601-0003', '310-0010')).toBe(40000);
    expect(cell(r.payments, '601-0001', '310-0010')).toBe(30000);
    expect(cell(r.payments, 'ADV', '310-0010')).toBe(30000);
    expect(cell(r.payments, '900-A001', '310-0010')).toBe(5000);
    expect(cell(r.payments, 'XFER:320-0000', '310-0010')).toBe(20000);
    /* The creditor control itself never appears as a row. */
    expect(r.payments.find((x) => x.key === '400-0000')).toBeUndefined();
    /* The reversed voucher is invisible. */
    expect(r.entries.some((e) => e.jeNo === 'JE-9')).toBe(false);

    expect(r.totals.receipts).toEqual({ '310-0010': 50000, '320-0000': 20000 });
    expect(r.totals.payments).toEqual({ '310-0010': 125000, '320-0000': 6000 });
    expect(r.totals.closing).toEqual({ '310-0010': -85000, '320-0000': 14000 });
    expect(r.totals.closingTotalSen).toBe(-71000);
    /* Rows carry their Total; entries carry the drill-down. */
    expect(r.payments.find((x) => x.key === '601-0003')?.totalSen).toBe(40000);
    expect(r.entries.filter((e) => e.jeNo === 'JE-3').map((e) => [e.rowKey, e.sen]).sort()).toEqual([['601-0001', 30000], ['601-0003', 40000], ['ADV', 30000]]);
  });

  test('party=1 names the control rows by debtor/creditor and does not split the supplier payment', async () => {
    const r = await fetchReport(harness(world()), 'from=2026-07-01&to=2026-07-31&party=1');
    expect(r.receipts.find((x) => x.key === '300-0000:Ah Meng')?.name).toBe('Ah Meng · ACCOUNT RECEIVEABLE');
    expect(cell(r.payments, '400-0000:FOSHAN CHAIRS', '310-0010')).toBe(100000);
    expect(r.payments.find((x) => x.key === '601-0003')).toBeUndefined();
    expect(r.totals.payments['310-0010']).toBe(125000); // the same money, differently named
  });

  test('an account filter narrows the columns; the other money account then reads as a transfer counterpart', async () => {
    const r = await fetchReport(harness(world()), 'from=2026-07-01&to=2026-07-31&accounts=320-0000');
    expect(r.columns.map((c) => c.code)).toEqual(['320-0000']);
    expect(cell(r.receipts, 'XFER:310-0010', '320-0000')).toBe(20000);
    expect(r.totals.closing).toEqual({ '320-0000': 14000 });
  });

  test('a bad range is refused', async () => {
    const res = await harness(world()).request('/accounting/reports/receipts-payments?from=2026-07-31&to=2026-07-01');
    expect(res.status).toBe(400);
  });
});
