// The deposit taken on a SALES ORDER, reaching the SALES INVOICES raised off it.
//
// THE BUG THIS PINS (owner, 2026-08-23 —「payment record怎么没带去invoice那边呢」):
// order HC-SO-2608-006 held a MYR 2,000 cash deposit while the invoice raised
// from it showed "No payments recorded yet" and an outstanding of the full
// 4,400. Two ledgers with no link — `mfg_sales_order_payments` keyed by
// `so_doc_no`, `sales_invoice_payments` keyed by `sales_invoice_id` — so the
// office was told to chase money the customer had already handed over.
//
// scm rides Supabase Postgres, which the D1 harness does not rebuild, so the
// DB-touching half drives a minimal fake PostgREST client. The allocation
// itself is pure and is tested directly, including the invariant that decides
// whether this is safe to put in front of money.
import { describe, expect, test } from 'vitest';
import {
  allocateOrderDeposit,
  sortForAllocation,
  absorbsOrderDeposit,
  readOrderDepositForInvoice,
  recomputeSiPaid,
  type AllocatableInvoice,
} from './si-order-deposit';

const inv = (o: Partial<AllocatableInvoice> & { id: string }): AllocatableInvoice => ({
  invoiceNumber: `HC-SI-2608-${o.id}`,
  invoiceDate: '2026-08-23',
  status: 'SENT',
  totalSen: 0,
  ownPaidSen: 0,
  ...o,
});

describe('allocateOrderDeposit — the owner\'s split rule', () => {
  /* His worked example, verbatim (2026-08-23): 先扣第一张，扣完再溢到下一张.
       第一张发票 3,000 → 扣 2,000，未收 1,000
       第二张发票 1,400 → 扣   0，未收 1,400 */
  test('the earliest invoice absorbs first, the rest spills to the next', () => {
    const slices = allocateOrderDeposit(200_000, [
      inv({ id: '002', invoiceNumber: 'HC-SI-2608-002', invoiceDate: '2026-08-20', totalSen: 300_000 }),
      inv({ id: '003', invoiceNumber: 'HC-SI-2608-003', invoiceDate: '2026-08-22', totalSen: 140_000 }),
    ]);
    expect(slices.get('002')).toBe(200_000);
    expect(slices.get('003')).toBe(0);
  });

  test('it spills once the first invoice is full', () => {
    const slices = allocateOrderDeposit(400_000, [
      inv({ id: 'a', invoiceNumber: 'HC-SI-2608-001', invoiceDate: '2026-08-20', totalSen: 300_000 }),
      inv({ id: 'b', invoiceNumber: 'HC-SI-2608-002', invoiceDate: '2026-08-22', totalSen: 140_000 }),
    ]);
    expect(slices.get('a')).toBe(300_000);
    expect(slices.get('b')).toBe(100_000);
  });

  test('input order does not decide the split — the sort key does', () => {
    const rows = [
      inv({ id: 'later', invoiceNumber: 'HC-SI-2608-009', invoiceDate: '2026-08-22', totalSen: 300_000 }),
      inv({ id: 'earlier', invoiceNumber: 'HC-SI-2608-001', invoiceDate: '2026-08-20', totalSen: 300_000 }),
    ];
    expect(allocateOrderDeposit(200_000, rows).get('earlier')).toBe(200_000);
    expect(allocateOrderDeposit(200_000, [...rows].reverse()).get('earlier')).toBe(200_000);
  });

  test('same date falls back to invoice number, and a null date sorts last', () => {
    const sorted = sortForAllocation([
      inv({ id: 'c', invoiceNumber: 'HC-SI-2608-004', invoiceDate: null }),
      inv({ id: 'b', invoiceNumber: 'HC-SI-2608-003', invoiceDate: '2026-08-20' }),
      inv({ id: 'a', invoiceNumber: 'HC-SI-2608-002', invoiceDate: '2026-08-20' }),
    ]).map((r) => r.id);
    expect(sorted).toEqual(['a', 'b', 'c']);
  });

  test('money already taken ON the invoice is not displaced by the order\'s', () => {
    const slices = allocateOrderDeposit(200_000, [
      inv({ id: 'a', invoiceNumber: 'HC-SI-2608-001', totalSen: 300_000, ownPaidSen: 250_000 }),
      inv({ id: 'b', invoiceNumber: 'HC-SI-2608-002', totalSen: 300_000 }),
    ]);
    expect(slices.get('a')).toBe(50_000);  // only what it still owed
    expect(slices.get('b')).toBe(150_000); // the rest spilled
  });

  test('a CANCELLED or DRAFT invoice absorbs nothing', () => {
    expect(absorbsOrderDeposit('CANCELLED')).toBe(false);
    expect(absorbsOrderDeposit('DRAFT')).toBe(false);
    for (const s of ['SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE']) {
      expect(absorbsOrderDeposit(s)).toBe(true);
    }
    const slices = allocateOrderDeposit(200_000, [
      inv({ id: 'dead', invoiceNumber: 'HC-SI-2608-001', invoiceDate: '2026-08-01', status: 'CANCELLED', totalSen: 500_000 }),
      inv({ id: 'draft', invoiceNumber: 'HC-SI-2608-002', invoiceDate: '2026-08-02', status: 'DRAFT', totalSen: 500_000 }),
      inv({ id: 'live', invoiceNumber: 'HC-SI-2608-003', invoiceDate: '2026-08-03', totalSen: 500_000 }),
    ]);
    expect(slices.get('dead')).toBe(0);
    expect(slices.get('draft')).toBe(0);
    expect(slices.get('live')).toBe(200_000);
  });

  /* THE MONEY INVARIANT. Nothing here may make an invoice look more paid than
     it is, and nothing may lose a customer's money between two invoices. Both
     halves are asserted over generated cases rather than a handful of examples,
     because the failure that matters is the combination nobody thought of. */
  test('the slices always sum to min(order collected, what the invoices could absorb)', () => {
    let seed = 20260823;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let round = 0; round < 400; round++) {
      const rows: AllocatableInvoice[] = [];
      for (let i = 0; i < 1 + rnd(4); i++) {
        const total = rnd(500_000);
        rows.push(inv({
          id: `i${i}`,
          invoiceNumber: `HC-SI-2608-${String(i).padStart(3, '0')}`,
          invoiceDate: rnd(3) === 0 ? null : `2026-08-${String(1 + rnd(28)).padStart(2, '0')}`,
          status: ['SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED', 'DRAFT'][rnd(6)]!,
          totalSen: total,
          ownPaidSen: rnd(2) === 0 ? rnd(total + 1) : 0,
        }));
      }
      const collected = rnd(1_500_000);
      const slices = allocateOrderDeposit(collected, rows);

      const absorbable = rows
        .filter((r) => absorbsOrderDeposit(r.status))
        .reduce((s, r) => s + Math.max(0, r.totalSen - r.ownPaidSen), 0);
      const allocated = [...slices.values()].reduce((s, v) => s + v, 0);

      // Total-preserving: nothing invented, nothing lost.
      expect(allocated).toBe(Math.min(collected, absorbable));
      // Never more than the order actually holds...
      expect(allocated).toBeLessThanOrEqual(collected);
      // ...and never more than any single invoice still owes.
      for (const r of rows) {
        const take = slices.get(r.id) ?? 0;
        expect(take).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(take)).toBe(true);
        expect(take).toBeLessThanOrEqual(absorbsOrderDeposit(r.status) ? Math.max(0, r.totalSen - r.ownPaidSen) : 0);
      }
    }
  });
});

// ── The DB half: the order's money must actually reach the invoice ──────────

type Store = {
  so: Record<string, unknown> | null;
  soErr: string | null;
  orderPayments: Array<Record<string, unknown>>;
  invoices: Array<Record<string, unknown>>;
  siPayments: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
};

const emptyStore = (o: Partial<Store> = {}): Store => ({
  so: { doc_no: 'HC-SO-2608-006', company_id: 1, total_revenue_sen: 440_000, deposit_sen: 0 },
  soErr: null,
  orderPayments: [],
  invoices: [],
  siPayments: [],
  updates: [],
  ...o,
});

/** Chainable, awaitable PostgREST stand-in over the four tables this reads. */
function fakeSb(store: Store) {
  class Q {
    table: string;
    op: 'select' | 'update' = 'select';
    cols = '';
    filters: Record<string, unknown> = {};
    payload: Record<string, unknown> | null = null;
    singleRow = false;
    constructor(table: string) { this.table = table; }
    select(cols?: string) { if (this.op === 'select') this.cols = cols ?? ''; return this; }
    update(payload: Record<string, unknown>) { this.op = 'update'; this.payload = payload; return this; }
    eq(col: string, val: unknown) { this.filters[col] = val; return this; }
    order() { return this; }
    maybeSingle() { this.singleRow = true; return this; }
    private result(): { data: unknown; error: unknown } {
      if (this.op === 'update') {
        store.updates.push({ id: this.filters.id, ...(this.payload ?? {}) });
        return { data: null, error: null };
      }
      if (this.table === 'mfg_sales_orders') {
        if (store.soErr) return { data: null, error: { message: store.soErr } };
        return { data: store.so, error: null };
      }
      if (this.table === 'mfg_sales_order_payments') {
        return { data: store.orderPayments.filter((r) => r.so_doc_no === this.filters.so_doc_no), error: null };
      }
      if (this.table === 'sales_invoice_payments') {
        return { data: store.siPayments.filter((r) => r.sales_invoice_id === this.filters.sales_invoice_id), error: null };
      }
      if (this.table === 'sales_invoices') {
        const rows = store.invoices.filter((r) =>
          (this.filters.id === undefined || r.id === this.filters.id)
          && (this.filters.so_doc_no === undefined || r.so_doc_no === this.filters.so_doc_no));
        return { data: this.singleRow ? (rows[0] ?? null) : rows, error: null };
      }
      return { data: this.singleRow ? null : [], error: null };
    }
    then<T>(onF: (v: { data: unknown; error: unknown }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.result()).then(onF, onR);
    }
  }
  return { from: (t: string) => new Q(t) };
}

/* The reported chain, rebuilt: one order carrying a 2,000 cash deposit, one
   4,400 invoice raised off it with nothing in its own ledger. */
const reportedChain = () => emptyStore({
  orderPayments: [{ id: 'pay-1', so_doc_no: 'HC-SO-2608-006', paid_at: '2026-08-23', method: 'cash', amount_sen: 200_000, account_sheet: 'Cash', note: null, is_deposit: true }],
  invoices: [{ id: 'si-1', so_doc_no: 'HC-SO-2608-006', company_id: 1, invoice_number: 'HC-SI-2608-004', invoice_date: '2026-08-23', status: 'SENT', total_sen: 440_000, paid_sen: 0 }],
});

describe('the invoice sees what the order collected', () => {
  test('the order deposit reaches the invoice that has no receipts of its own', async () => {
    const store = reportedChain();
    const r = await readOrderDepositForInvoice(fakeSb(store), { id: 'si-1', so_doc_no: 'HC-SO-2608-006', company_id: 1 });
    expect(r.ok).toBe(true);
    const dep = (r as { ok: true; deposit: NonNullable<Awaited<ReturnType<typeof readOrderDepositForInvoice>> extends { deposit: infer D } ? D : never> }).deposit;
    expect(dep).not.toBeNull();
    expect(dep!.applied_sen).toBe(200_000);
    expect(dep!.order_collected_sen).toBe(200_000);
    // "Which document took the money" is part of the answer, not a footnote.
    expect(dep!.so_doc_no).toBe('HC-SO-2608-006');
    expect(dep!.transactions).toHaveLength(1);
    expect(dep!.transactions[0]!.method).toBe('cash');
  });

  test('the LEGACY header deposit counts too — an AutoCount order with no ledger row', async () => {
    const store = reportedChain();
    store.orderPayments = [];
    store.so = { doc_no: 'HC-SO-2608-006', company_id: 1, total_revenue_sen: 440_000, deposit_sen: 200_000 };
    const r = await readOrderDepositForInvoice(fakeSb(store), { id: 'si-1', so_doc_no: 'HC-SO-2608-006', company_id: 1 });
    expect((r as { ok: true; deposit: { applied_sen: number } | null }).deposit!.applied_sen).toBe(200_000);
  });

  test('a failed order read is NOT an order with no deposit', async () => {
    const store = reportedChain();
    store.soErr = 'connection reset';
    const r = await readOrderDepositForInvoice(fakeSb(store), { id: 'si-1', so_doc_no: 'HC-SO-2608-006', company_id: 1 });
    expect(r.ok).toBe(false);
  });

  test('no company means no cross-tenant read — it refuses rather than answering 0', async () => {
    const r = await readOrderDepositForInvoice(fakeSb(reportedChain()), { id: 'si-1', so_doc_no: 'HC-SO-2608-006', company_id: null });
    expect(r.ok).toBe(false);
  });

  test('a manual invoice with no order behind it has nothing to show', async () => {
    const r = await readOrderDepositForInvoice(fakeSb(reportedChain()), { id: 'si-1', so_doc_no: null, company_id: 1 });
    expect(r).toEqual({ ok: true, deposit: null });
  });
});

describe('recomputeSiPaid — the number and the status pill agree', () => {
  test('a deposit that partly settles the invoice moves it to PARTIALLY_PAID', async () => {
    const store = reportedChain();
    await recomputeSiPaid(fakeSb(store), 'si-1');
    const u = store.updates.at(-1)!;
    // paid_sen keeps its old meaning: receipts taken on THIS invoice.
    expect(u.paid_sen).toBe(0);
    // ...but the status the office reads counts the order's money.
    expect(u.status).toBe('PARTIALLY_PAID');
  });

  test('a deposit that covers the invoice in full moves it to PAID', async () => {
    const store = reportedChain();
    store.orderPayments[0]!.amount_sen = 440_000;
    await recomputeSiPaid(fakeSb(store), 'si-1');
    expect(store.updates.at(-1)!.status).toBe('PAID');
  });

  test('an order with no money leaves the invoice SENT', async () => {
    const store = reportedChain();
    store.orderPayments = [];
    await recomputeSiPaid(fakeSb(store), 'si-1');
    expect(store.updates.at(-1)!.status).toBe('SENT');
  });

  test('a failed deposit read leaves the STATUS alone rather than reverting it', async () => {
    const store = reportedChain();
    store.invoices[0]!.status = 'PARTIALLY_PAID';
    store.soErr = 'connection reset';
    await recomputeSiPaid(fakeSb(store), 'si-1');
    const u = store.updates.at(-1)!;
    expect(u.paid_sen).toBe(0);
    expect('status' in u).toBe(false);
  });

  test('a CANCELLED invoice is never moved by the order\'s money', async () => {
    const store = reportedChain();
    store.invoices[0]!.status = 'CANCELLED';
    await recomputeSiPaid(fakeSb(store), 'si-1');
    expect('status' in store.updates.at(-1)!).toBe(false);
  });

  test('a DRAFT invoice is never moved by the order\'s money', async () => {
    const store = reportedChain();
    store.invoices[0]!.status = 'DRAFT';
    await recomputeSiPaid(fakeSb(store), 'si-1');
    expect('status' in store.updates.at(-1)!).toBe(false);
  });

  test('the second invoice is only settled by what the first one left', async () => {
    const store = reportedChain();
    store.invoices = [
      { id: 'si-1', so_doc_no: 'HC-SO-2608-006', company_id: 1, invoice_number: 'HC-SI-2608-004', invoice_date: '2026-08-23', status: 'SENT', total_sen: 300_000, paid_sen: 0 },
      { id: 'si-2', so_doc_no: 'HC-SO-2608-006', company_id: 1, invoice_number: 'HC-SI-2608-005', invoice_date: '2026-08-24', status: 'SENT', total_sen: 140_000, paid_sen: 0 },
    ];
    const sb = fakeSb(store);
    await recomputeSiPaid(sb, 'si-1');
    expect(store.updates.at(-1)!.status).toBe('PARTIALLY_PAID');
    await recomputeSiPaid(sb, 'si-2');
    expect(store.updates.at(-1)!.status).toBe('SENT');
  });
});
