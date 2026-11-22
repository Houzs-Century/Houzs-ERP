/* Deposit-invoice reads (port of Conts D18):
     • the backlog lists every payment, not the first 1000 (it asked for
       .limit(2000) under PostgREST's 1000-row ceiling, and read the standing
       invoices with no paging at all);
     • the edit hook, having just read that no invoice stands for the payment,
       does not read it a second time before issuing. */
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { missingDepositInvoices, reissueDepositInvoiceBestEffort } from '../src/acc/deposit-invoices';

const CO = 2;
const ON = { company_id: CO, deposit_invoice_enabled: true, deposit_invoice_from: '2026-09-01' };
const ORDER = { doc_no: '2990-SO-2609-001', company_id: CO, debtor_code: null, debtor_name: 'Larding Chen', customer_id: 'cust-larding', status: 'CONFIRMED' };

function world(payments: Row[], settings: Row[]) {
  return fakeSb({
    companies: [{ id: CO, code: '2990', name: '2990' }],
    mfg_sales_orders: [{ ...ORDER }],
    mfg_sales_order_payments: payments,
    sales_invoices: [],
    acc_company_settings: settings,
    acc_deposit_invoices: [],
    acc_credit_notes: [],
    journal_entries: [], journal_entry_lines: [],
  }, {}, [], ['journal_entry_lines'], 1000);
}

const pay = (n: number): Row => ({
  id: `p-${String(n).padStart(4, '0')}`, so_doc_no: ORDER.doc_no, paid_at: '2026-09-05', method: 'cash', amount_sen: 10_000, created_by: 'u-1', company_id: CO,
});

describe('deposit invoice reads', () => {
  test('the backlog lists every payment owed an invoice, past the 1000-row ceiling', async () => {
    const payments = Array.from({ length: 1200 }, (_, i) => pay(i + 1));
    const r = await missingDepositInvoices(world(payments, [{ ...ON }]) as never, CO);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payments).toHaveLength(1200);
  });

  test('the edit hook reads the standing invoice once when there is none', async () => {
    const sb = world([pay(1)], [{ ...ON, deposit_invoice_enabled: false }]);
    const read: string[] = [];
    const counted = { ...sb, from: (t: string) => { read.push(t); return sb.from(t); } };
    await reissueDepositInvoiceBestEffort(counted as never, { paymentId: 'p-0001', docNo: ORDER.doc_no, paidAt: '2026-09-05', amountSen: 10_000, method: 'cash', actor: null });
    expect(read.filter((t) => t === 'acc_deposit_invoices')).toHaveLength(1);
  });
});
