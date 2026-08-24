// The Outstanding Dashboard's SI card must agree with the table under it.
//
// WHAT WENT WRONG. #2684 made the SI ROW LIST net of the deposit taken on the
// source Sales Order, and left `/outstanding/summary` on its SQL aggregate over
// `v_si_outstanding.outstanding_sen` (= `total_sen - paid_sen`). So one page
// carried two numbers for the same money and the BIGGER one was the headline —
// the figure a person reads to decide how much is owed.
//
// The three things this pins are the three ways the fix could be worse than the
// bug: a figure that is too SMALL (money quietly stops being chased), a ZERO
// where the read failed (reads as "nothing outstanding"), and a cap that
// silently stops counting.
import { describe, expect, test } from 'vitest';
import {
  summariseSiOutstanding,
  unavailableSiSummary,
  SI_SUMMARY_ROW_CAP,
} from './si-outstanding-summary';

type Row = Record<string, unknown>;

const AGG = { count: 2, total_sen: 440_000 + 300_000, total_outstanding_sen: 440_000 + 300_000 };

/* One order holding 2,000, one 4,400 invoice off it, plus an unrelated 3,000
   invoice with no order. The owner's reported chain plus a control. */
const baseRows = (): Row[] => ([
  { id: 'si-1', so_doc_no: 'HC-SO-2608-006', total_sen: 440_000, outstanding_sen: 440_000 },
  { id: 'si-9', so_doc_no: null, total_sen: 300_000, outstanding_sen: 300_000 },
]);

type Store = {
  orders: Row[]; payments: Row[]; invoices: Row[];
  stampFails: boolean;
  reads: string[];
};
const store = (o: Partial<Store> = {}): Store => ({
  orders: [{ doc_no: 'HC-SO-2608-006', company_id: 1, total_revenue_sen: 440_000, deposit_sen: 0 }],
  payments: [{ so_doc_no: 'HC-SO-2608-006', amount_sen: 200_000, is_deposit: true }],
  invoices: [{ id: 'si-1', so_doc_no: 'HC-SO-2608-006', company_id: 1, invoice_number: 'HC-SI-2608-004', invoice_date: '2026-08-23', status: 'SENT', total_sen: 440_000, paid_sen: 0 }],
  stampFails: false,
  reads: [],
  ...o,
});

/** PostgREST stand-in for the three tables `stampOrderDeposit` reads. */
function fakeSb(st: Store) {
  class Q {
    table: string; filters: Record<string, unknown> = {}; ins: Record<string, unknown[]> = {};
    constructor(t: string) { this.table = t; }
    select() { return this; }
    eq(c: string, v: unknown) { this.filters[c] = v; return this; }
    in(c: string, v: unknown[]) { this.ins[c] = v; return this; }
    order() { return this; }
    private rows(src: Row[]) {
      return src.filter((r) => {
        for (const [c, v] of Object.entries(this.filters)) if (r[c] !== v) return false;
        for (const [c, vs] of Object.entries(this.ins)) if (!vs.includes(r[c])) return false;
        return true;
      });
    }
    private result() {
      st.reads.push(this.table);
      if (st.stampFails) return { data: null, error: { message: 'order read blip' } };
      if (this.table === 'mfg_sales_orders') return { data: this.rows(st.orders), error: null };
      if (this.table === 'mfg_sales_order_payments') return { data: this.rows(st.payments), error: null };
      if (this.table === 'sales_invoices') return { data: this.rows(st.invoices), error: null };
      return { data: [], error: null };
    }
    then<T>(f: (v: { data: unknown; error: unknown }) => T, r?: (e: unknown) => T) {
      return Promise.resolve(this.result()).then(f, r);
    }
  }
  return { from: (t: string) => new Q(t) };
}

const onePage = (rows: Row[]) => async () => ({ data: rows, error: null });

describe('the card and the rows agree', () => {
  test('the SI total is net of the order deposit, and the rest is untouched', async () => {
    const r = await summariseSiOutstanding(fakeSb(store()), onePage(baseRows()), 1, AGG);
    // 4,400 - 2,000 for the invoice with an order, 3,000 for the one without.
    expect(r.total_outstanding_sen).toBe(240_000 + 300_000);
    expect(r.count).toBe(2);
    expect(r.total_sen).toBe(740_000);
    expect(r.deposit_applied).toBe(true);
    expect(r.deposit_note).toBeNull();
  });

  /* The bug this whole PR exists for: the aggregate answered the un-adjusted
     740,000 while the table under it summed 540,000. */
  test('it lands BELOW the SQL aggregate it refines', async () => {
    const r = await summariseSiOutstanding(fakeSb(store()), onePage(baseRows()), 1, AGG);
    expect(r.total_outstanding_sen).toBeLessThan(AGG.total_outstanding_sen);
  });
});

describe('it is never smaller than the truth', () => {
  test('a failed deposit read keeps the LARGER figure and says the deposits are not in it', async () => {
    const st = store({ stampFails: true });
    const r = await summariseSiOutstanding(fakeSb(st), onePage(baseRows()), 1, AGG);
    expect(r.total_outstanding_sen).toBe(740_000);
    expect(r.deposit_applied).toBe(false);
    expect(r.deposit_note).toMatch(/too high/);
    expect(r.unavailable).toBeUndefined();
  });

  test('an unresolved order is COUNTED, never dropped', async () => {
    const st = store({ stampFails: true });
    const r = await summariseSiOutstanding(fakeSb(st), onePage(baseRows()), 1, AGG);
    expect(r.count).toBe(2);
  });

  /* THE CAP MUST NOT SILENTLY STOP COUNTING. A summary that quietly drops rows
     is worse than one that is too big: too big at least looks wrong. */
  test('more invoices than the cap keeps the aggregate rather than truncating', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ id: `si-${i}`, so_doc_no: null, total_sen: 100, outstanding_sen: 100 }));
    const big = { count: 99_999, total_sen: 9_999_999, total_outstanding_sen: 9_999_999 };
    const r = await summariseSiOutstanding(fakeSb(store()), onePage(many), 1, big);
    expect(r.count).toBe(99_999);
    expect(r.total_outstanding_sen).toBe(9_999_999);
    expect(r.deposit_applied).toBe(false);
    expect(r.deposit_note).toContain(String(SI_SUMMARY_ROW_CAP));
  });

  test('the cap stops the scan — it does not read forever', async () => {
    let pages = 0;
    const many = Array.from({ length: 1000 }, (_, i) => ({ id: `x-${i}`, so_doc_no: null, total_sen: 1, outstanding_sen: 1 }));
    await summariseSiOutstanding(
      fakeSb(store()),
      async () => { pages += 1; return { data: many, error: null }; },
      1,
      { count: 1, total_sen: 1, total_outstanding_sen: 1 },
    );
    expect(pages).toBe(SI_SUMMARY_ROW_CAP / 1000);
  });
});

describe('a failed read is not "nothing outstanding"', () => {
  test('a scan error with no aggregate answers UNAVAILABLE, not zero', async () => {
    const r = await summariseSiOutstanding(
      fakeSb(store()),
      async () => ({ data: null, error: { message: 'connection reset' } }),
      1,
      null,
    );
    expect(r.unavailable).toBe(true);
    expect(r.deposit_note).toContain('connection reset');
  });

  test('a scan error WITH an aggregate keeps the real number and flags it', async () => {
    const r = await summariseSiOutstanding(
      fakeSb(store()),
      async () => ({ data: null, error: { message: 'connection reset' } }),
      1,
      AGG,
    );
    expect(r.unavailable).toBeUndefined();
    expect(r.total_outstanding_sen).toBe(AGG.total_outstanding_sen);
    expect(r.deposit_applied).toBe(false);
  });

  test('over the cap with no aggregate is UNAVAILABLE, never a partial count', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ id: `y-${i}`, so_doc_no: null, total_sen: 100, outstanding_sen: 100 }));
    const r = await summariseSiOutstanding(fakeSb(store()), onePage(many), 1, null);
    expect(r.unavailable).toBe(true);
  });

  test('the unavailable shape carries zeros AND the flag, so a reader cannot mistake it for a real zero', () => {
    const u = unavailableSiSummary('view missing');
    expect(u.unavailable).toBe(true);
    expect(u.count).toBe(0);
    expect(u.deposit_applied).toBe(false);
    expect(u.deposit_note).toContain('view missing');
  });
});

describe('cost', () => {
  test('no orders on the page means no deposit reads at all', async () => {
    const st = store();
    await summariseSiOutstanding(fakeSb(st), onePage([{ id: 'a', so_doc_no: null, total_sen: 1, outstanding_sen: 1 }]), 1, AGG);
    expect(st.reads).toHaveLength(0);
  });

  /* The stamp's sibling read carries the order numbers in the request URI, and
     an unbounded `.in()` list is a REJECTED request, not a slow one
     (paginate-all.ts, URL_QUERY_BUDGET — measured in production 2026-08-17/18).
     600 distinct orders must therefore become several bounded calls. */
  test('600 distinct orders are read in bounded batches, not one giant IN list', async () => {
    const st = store({ orders: [], payments: [], invoices: [] });
    const rows = Array.from({ length: 600 }, (_, i) => ({ id: `si-${i}`, so_doc_no: `HC-SO-2608-${i}`, total_sen: 100, outstanding_sen: 100 }));
    await summariseSiOutstanding(fakeSb(st), onePage(rows), 1, AGG);
    const batches = st.reads.length / 3;
    expect(Number.isInteger(batches)).toBe(true);
    expect(batches).toBeGreaterThan(1);
    expect(batches).toBeLessThanOrEqual(600 / 100);
  });
});
