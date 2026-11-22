// Customer credit must not be spent on an invoice its sales order already paid.
//
// Callers hand applyCustomerCreditToSi `total - paid_sen`, and paid_sen holds only
// the receipts taken on the invoice itself. The deposit and payments collected on
// the sales order settle the invoice too (si-order-deposit), so an invoice raised
// off a fully paid order looked fully owed and the customer's credit was applied
// to it. Production had 13 such credit receipts, every one on an order already paid.
import { describe, expect, test } from 'vitest';
import { applyCustomerCreditToSi } from './customer-credits';

type Row = Record<string, unknown>;

type World = {
  soDocNo: string | null;
  invoiceTotalSen: number;
  orderPaymentsSen: number[];
  creditNoteSen: number;
  orderPaymentsError: string | null;
  rpcCalls: Row[];
};

function fakeSb(w: World) {
  class Q {
    cols = '';
    single = false;
    constructor(public table: string) {}
    select(cols?: string) { this.cols = cols ?? ''; return this; }
    eq() { return this; }
    in() { return this; }
    order() { return this; }
    range() { return this; }
    limit() { return this; }
    maybeSingle() { this.single = true; return this; }
    private result(): { data: unknown; error: unknown } {
      if (this.table === 'sales_invoices' && this.cols.includes('migrated_no_stock')) {
        return { data: { migrated_no_stock: false, so_doc_no: w.soDocNo, company_id: 1 }, error: null };
      }
      if (this.table === 'sales_invoices') {
        return {
          data: [{ id: 'si-1', invoice_number: 'HC-SI-2611-001', invoice_date: '2026-11-01', status: 'SENT', total_sen: w.invoiceTotalSen, paid_sen: 0 }],
          error: null,
        };
      }
      if (this.table === 'mfg_sales_orders') {
        return { data: { doc_no: w.soDocNo, company_id: 1, total_revenue_sen: w.invoiceTotalSen, deposit_sen: 0 }, error: null };
      }
      if (this.table === 'mfg_sales_order_payments') {
        if (w.orderPaymentsError) return { data: null, error: { message: w.orderPaymentsError } };
        return {
          data: w.orderPaymentsSen.map((a, i) => ({ id: `p${i}`, paid_at: '2026-10-01', method: 'cash', amount_sen: a, account_sheet: null, note: null, is_deposit: i === 0 })),
          error: null,
        };
      }
      if (this.table === 'acc_credit_note_allocations') {
        return { data: w.creditNoteSen > 0 ? [{ id: 'a1', note_id: 'n1', sales_invoice_id: 'si-1', applied_sen: w.creditNoteSen }] : [], error: null };
      }
      if (this.table === 'acc_credit_notes') {
        return { data: [{ id: 'n1', status: 'POSTED' }], error: null };
      }
      return { data: this.single ? null : [], error: null };
    }
    then<T>(onF: (v: { data: unknown; error: unknown }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.result()).then(onF, onR);
    }
  }
  return {
    from: (t: string) => new Q(t),
    rpc: (_fn: string, params: Row) => {
      w.rpcCalls.push(params);
      const due = Number(params.p_remaining_due_sen);
      return Promise.resolve({ data: [{ applied_sen: Math.min(due, 100_000), reason: null }], error: null });
    },
  };
}

function world(over: Partial<World> = {}): World {
  return { soDocNo: 'SO-1', invoiceTotalSen: 50_000, orderPaymentsSen: [], creditNoteSen: 0, orderPaymentsError: null, rpcCalls: [], ...over };
}

const ARGS = { debtorCode: 'CUST-1', debtorName: 'Alice', siId: 'si-1', siNumber: 'HC-SI-2611-001', remainingDueSen: 50_000, createdBy: 'staff-1' };

describe('applyCustomerCreditToSi — the order\'s money settles the invoice first', () => {
  test('an invoice whose order collected its whole total spends no credit', async () => {
    const w = world({ orderPaymentsSen: [20_000, 30_000] });
    const res = await applyCustomerCreditToSi(fakeSb(w), ARGS);
    expect(res).toEqual({ applied: 0, reason: 'settled_by_order' });
    expect(w.rpcCalls).toHaveLength(0);
  });

  test('a part-paid order leaves only the rest for the credit', async () => {
    const w = world({ orderPaymentsSen: [20_000] });
    const res = await applyCustomerCreditToSi(fakeSb(w), ARGS);
    expect(w.rpcCalls[0].p_remaining_due_sen).toBe(30_000);
    expect(res).toEqual({ applied: 30_000 });
  });

  test('a credit note on the invoice reduces what the credit may cover', async () => {
    const w = world({ orderPaymentsSen: [20_000], creditNoteSen: 10_000 });
    await applyCustomerCreditToSi(fakeSb(w), ARGS);
    expect(w.rpcCalls[0].p_remaining_due_sen).toBe(20_000);
  });

  test('an invoice with no sales order behind it is unchanged', async () => {
    const w = world({ soDocNo: null });
    await applyCustomerCreditToSi(fakeSb(w), ARGS);
    expect(w.rpcCalls[0].p_remaining_due_sen).toBe(50_000);
  });

  test('an unreadable order refuses instead of spending the credit', async () => {
    const w = world({ orderPaymentsError: 'timeout' });
    const res = await applyCustomerCreditToSi(fakeSb(w), ARGS);
    expect(res.applied).toBe(0);
    expect(res.reason).toMatch(/^order_money_read_failed/);
    expect(w.rpcCalls).toHaveLength(0);
  });
});
