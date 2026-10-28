// The order's deposit must reach the LIST, not just the detail page.
//
// WHY THIS FILE IS SEPARATE FROM si-order-deposit.test.ts. That one pins the
// RULE. This one pins the thing that actually went wrong in production: the
// rule existed, the detail page used it, and every other screen did not. On
// 2026-08-23, after the detail-only fix shipped, `HC-SI-2608-004` read 2,400 on
// the detail page and 4,400 on the list the office scans to decide who to
// chase. A rule nothing calls is not a fix.
import { describe, expect, test } from 'vitest';
import { stampOrderDeposit } from './si-order-deposit';

type Store = {
  orders: Array<Record<string, unknown>>;
  payments: Array<Record<string, unknown>>;
  invoices: Array<Record<string, unknown>>;
  fail: 'orders' | 'payments' | 'invoices' | null;
  reads: string[];
};

/** Chainable PostgREST stand-in supporting the `.in()` batched reads. */
function fakeSb(store: Store) {
  class Q {
    table: string;
    filters: Record<string, unknown> = {};
    ins: Record<string, unknown[]> = {};
    constructor(table: string) { this.table = table; }
    select() { return this; }
    eq(col: string, val: unknown) { this.filters[col] = val; return this; }
    in(col: string, vals: unknown[]) { this.ins[col] = vals; return this; }
    order() { return this; }
    private rows(src: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
      return src.filter((r) => {
        for (const [c, v] of Object.entries(this.filters)) if (r[c] !== v) return false;
        for (const [c, vs] of Object.entries(this.ins)) if (!vs.includes(r[c])) return false;
        return true;
      });
    }
    private result(): { data: unknown; error: unknown } {
      store.reads.push(this.table);
      if (this.table === 'mfg_sales_orders') {
        return store.fail === 'orders' ? { data: null, error: { message: 'orders blip' } } : { data: this.rows(store.orders), error: null };
      }
      if (this.table === 'mfg_sales_order_payments') {
        return store.fail === 'payments' ? { data: null, error: { message: 'payments blip' } } : { data: this.rows(store.payments), error: null };
      }
      if (this.table === 'sales_invoices') {
        return store.fail === 'invoices' ? { data: null, error: { message: 'invoices blip' } } : { data: this.rows(store.invoices), error: null };
      }
      return { data: [], error: null };
    }
    then<T>(onF: (v: { data: unknown; error: unknown }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.result()).then(onF, onR);
    }
  }
  return { from: (t: string) => new Q(t) };
}

/* One order holding 2,000, two invoices off it: 3,000 then 1,400.
   The owner's worked example (2026-08-23) as a database. */
const twoInvoiceOrder = (): Store => ({
  orders: [{ doc_no: 'HC-SO-2608-006', company_id: 1, total_revenue_sen: 440_000, deposit_sen: 0 }],
  payments: [{ so_doc_no: 'HC-SO-2608-006', amount_sen: 200_000, is_deposit: true }],
  invoices: [
    { id: 'si-1', so_doc_no: 'HC-SO-2608-006', company_id: 1, invoice_number: 'HC-SI-2608-004', invoice_date: '2026-08-23', status: 'SENT', total_sen: 300_000, paid_sen: 0 },
    { id: 'si-2', so_doc_no: 'HC-SO-2608-006', company_id: 1, invoice_number: 'HC-SI-2608-005', invoice_date: '2026-08-24', status: 'SENT', total_sen: 140_000, paid_sen: 0 },
  ],
  fail: null,
  reads: [],
});

describe('stampOrderDeposit', () => {
  test('a list row learns what its order collected', async () => {
    const store = twoInvoiceOrder();
    const rows = [{ id: 'si-1', so_doc_no: 'HC-SO-2608-006' }] as Array<Record<string, unknown>>;
    await stampOrderDeposit(fakeSb(store), rows, 1);
    expect(rows[0]!.so_deposit_applied_sen).toBe(200_000);
  });

  /* THE PAGE IS NOT THE POPULATION. si-2 is on page 2; if the allocation ran
     over the page's rows alone it would hand si-2 the same 2,000 that si-1
     already took, and the two pages would together claim 4,000 of a 2,000
     deposit. */
  test('a sibling that is NOT on this page still takes its share first', async () => {
    const store = twoInvoiceOrder();
    const pageTwo = [{ id: 'si-2', so_doc_no: 'HC-SO-2608-006' }] as Array<Record<string, unknown>>;
    await stampOrderDeposit(fakeSb(store), pageTwo, 1);
    expect(pageTwo[0]!.so_deposit_applied_sen).toBe(0);
  });

  test('both rows on one page split it the owner\'s way, and the two sum to the deposit', async () => {
    const store = twoInvoiceOrder();
    const rows = [
      { id: 'si-2', so_doc_no: 'HC-SO-2608-006' },
      { id: 'si-1', so_doc_no: 'HC-SO-2608-006' },
    ] as Array<Record<string, unknown>>;
    await stampOrderDeposit(fakeSb(store), rows, 1);
    expect(rows.find((r) => r.id === 'si-1')!.so_deposit_applied_sen).toBe(200_000);
    expect(rows.find((r) => r.id === 'si-2')!.so_deposit_applied_sen).toBe(0);
    const total = rows.reduce((s, r) => s + Number(r.so_deposit_applied_sen ?? 0), 0);
    expect(total).toBe(200_000);
  });

  test('an invoice with no order behind it gets a real zero, not a null', async () => {
    const store = twoInvoiceOrder();
    const rows = [{ id: 'manual', so_doc_no: null }] as Array<Record<string, unknown>>;
    await stampOrderDeposit(fakeSb(store), rows, 1);
    expect(rows[0]!.so_deposit_applied_sen).toBe(0);
  });

  /* Three reads for the page, not three per row — the whole reason the stamp is
     batched. Twenty rows on one order must not become sixty round trips. */
  test('it costs THREE reads for the whole page', async () => {
    const store = twoInvoiceOrder();
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: `si-${i}`, so_doc_no: 'HC-SO-2608-006' }));
    await stampOrderDeposit(fakeSb(store), rows as Array<Record<string, unknown>>, 1);
    expect(store.reads).toHaveLength(3);
  });

  for (const which of ['orders', 'payments', 'invoices'] as const) {
    test(`a failed ${which} read leaves the field NULL so the row keeps the larger outstanding`, async () => {
      const store = twoInvoiceOrder();
      store.fail = which;
      const rows = [{ id: 'si-1', so_doc_no: 'HC-SO-2608-006' }] as Array<Record<string, unknown>>;
      await stampOrderDeposit(fakeSb(store), rows, 1);
      expect(rows[0]!.so_deposit_applied_sen).toBeNull();
    });
  }

  test('no active company means no cross-tenant read at all', async () => {
    const store = twoInvoiceOrder();
    const rows = [{ id: 'si-1', so_doc_no: 'HC-SO-2608-006' }] as Array<Record<string, unknown>>;
    await stampOrderDeposit(fakeSb(store), rows, null);
    expect(rows[0]!.so_deposit_applied_sen).toBeNull();
    expect(store.reads).toHaveLength(0);
  });

  test('another company\'s order cannot pay this company\'s invoice', async () => {
    const store = twoInvoiceOrder();
    store.orders[0]!.company_id = 2;
    const rows = [{ id: 'si-1', so_doc_no: 'HC-SO-2608-006' }] as Array<Record<string, unknown>>;
    await stampOrderDeposit(fakeSb(store), rows, 1);
    expect(rows[0]!.so_deposit_applied_sen).toBe(0);
  });

  test('a CANCELLED sibling does not swallow the deposit ahead of the live one', async () => {
    const store = twoInvoiceOrder();
    store.invoices[0]!.status = 'CANCELLED';
    const rows = [
      { id: 'si-1', so_doc_no: 'HC-SO-2608-006' },
      { id: 'si-2', so_doc_no: 'HC-SO-2608-006' },
    ] as Array<Record<string, unknown>>;
    await stampOrderDeposit(fakeSb(store), rows, 1);
    expect(rows[0]!.so_deposit_applied_sen).toBe(0);
    expect(rows[1]!.so_deposit_applied_sen).toBe(140_000);
  });

  test('the LEGACY header deposit reaches the list too', async () => {
    const store = twoInvoiceOrder();
    store.payments = [];
    store.orders[0]!.deposit_sen = 200_000;
    const rows = [{ id: 'si-1', so_doc_no: 'HC-SO-2608-006' }] as Array<Record<string, unknown>>;
    await stampOrderDeposit(fakeSb(store), rows, 1);
    expect(rows[0]!.so_deposit_applied_sen).toBe(200_000);
  });

  test('an empty page reads nothing', async () => {
    const store = twoInvoiceOrder();
    await stampOrderDeposit(fakeSb(store), [], 1);
    expect(store.reads).toHaveLength(0);
  });
});
