/* OVER-COLLECTION IS LEGAL — owner's ruling 2026-08-16:
   「需要可以超收 negative 边红色」.

   THE DEFECT THIS PINS, reproduced end to end. `POST /:docNo/payments` carried
   Spec D6's guard:

     if (totalCenti > 0 && paidCenti + p.amountCenti > totalCenti) -> 400 over_payment

   so the system refused any receipt that would take an order past its own
   total, and the balance had no way to go negative. On HC-SO-2608-002 the
   consequence is in scm.mfg_so_audit_log: RM 4,000 order, RM 2,000 banked,
   RM 2,250 refused at 08:26 — and at 08:26:22 a line's unitPriceCenti went
   0 -> 25000 with a "Right Drawer" special worth exactly RM 250, after which
   the same RM 2,250 booked at 08:27:38. RM 250 of CASH was recorded by
   inflating the ORDER. The guard did not prevent the over-collection; it
   redirected it into item value, where it corrupts revenue, margin and the
   customer's own document.

   WHY A ROUTE TEST AND NOT A UNIT TEST: the bug is in the HANDLER, and what
   must be true is partly an ABSENCE (no refusal) and partly a NEGATIVE (the
   write that must NOT happen). Both are invisible to a test of the arithmetic.
   These handlers run on Supabase/PostgREST, which this suite does not bind, so
   the client is faked at the module boundary — the handler, its middleware, its
   validation and `recordSoPaymentRow` all execute for real.

   Numbers, measured: on `main` the first test below gets **400 over_payment**
   with **0 rows written**; with this change it gets **201** and **1** row in
   `mfg_sales_order_payments`, and the balance reads **-RM 250.00**. */

import { describe, expect, test, vi } from 'vitest';
import { soBalanceOf } from '../src/scm/shared/so-balance';
import routeSource from '../src/scm/routes/mfg-sales-orders.ts?raw';

type Row = Record<string, unknown>;

/** Every statement the handler issued, in order — `INSERT mfg_...`, `UPDATE ...`. */
const state: { tables: Record<string, Row[]>; statements: string[] } = { tables: {}, statements: [] };

/* A PostgREST-shaped fake. Deliberately tiny: it records what was WRITTEN and
   answers reads off `state.tables`. Anything it cannot answer returns an empty
   set, which is the shape supabase-js gives for "no rows" — never a throw, so a
   handler that mis-reads fails the assertion rather than the harness. */
function makeQuery(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let written: Row | null = null;
  const rows = () => (state.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const q: Record<string, unknown> = {
    select: () => q,
    eq: (col: string, val: unknown) => { filters.push((r) => String(r[col]) === String(val)); return q; },
    neq: (col: string, val: unknown) => { filters.push((r) => String(r[col]) !== String(val)); return q; },
    in: () => q, not: () => q, or: () => q, order: () => q, limit: () => q, range: () => q,
    like: () => q, ilike: () => q, is: () => q, gt: () => q, gte: () => q, lt: () => q, lte: () => q,
    filter: () => q, match: () => q, contains: () => q, overlaps: () => q,
    maybeSingle: () => Promise.resolve({ data: written ?? rows()[0] ?? null, error: null }),
    single: () => Promise.resolve({ data: written ?? rows()[0] ?? null, error: null }),
    insert: (v: Row) => {
      state.statements.push(`INSERT ${table}`);
      written = { id: 'pay-new', ...v };
      (state.tables[table] ??= []).push(written);
      return q;
    },
    update: (v: Row) => { state.statements.push(`UPDATE ${table} ${Object.keys(v).sort().join(',')}`); return q; },
    delete: () => { state.statements.push(`DELETE ${table}`); return q; },
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve({ data: written ? [written] : rows(), error: null, count: rows().length }).then(res, rej),
  };
  return q;
}
const fakeSb = { from: (t: string) => makeQuery(t) };

vi.mock('../src/db/supabase', () => ({
  getSupabaseService: () => fakeSb,
  getSupabase: () => fakeSb,
}));

const { Hono } = await import('hono');
const { mfgSalesOrders } = await import('../src/scm/routes/mfg-sales-orders');

/** The order this fix exists for: RM 4,000 of goods with RM 2,000 already banked. */
function seedOrder(): void {
  state.tables = {
    mfg_sales_orders: [{
      doc_no: 'HC-SO-TEST-001',
      status: 'CONFIRMED',
      company_id: 1,
      salesperson_id: null,
      local_total_centi: 400_00,
      total_revenue_centi: 400_00,
      deposit_centi: 0,
    }],
    mfg_sales_order_payments: [{ id: 'pay-1', so_doc_no: 'HC-SO-TEST-001', amount_centi: 200_00 }],
  };
  state.statements = [];
}

async function postPayment(amountCenti: number): Promise<Response> {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user' as never, {
      id: 7, email: 'tester@houzs.test', name: 'Tester',
      permissions: ['*'], permissions_set: new Set(['*']),
    } as never);
    await next();
  });
  app.route('/', mfgSalesOrders);
  return app.request('/HC-SO-TEST-001/payments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paidAt: '2026-08-16', method: 'cash', amountCenti }),
  }, {} as never);
}

describe('POST /:docNo/payments — a receipt larger than the balance', () => {
  test('SAVES, instead of answering 400 over_payment', async () => {
    seedOrder();
    const res = await postPayment(225_00);
    const body = await res.json() as { error?: string; payment?: Row };

    expect(body.error, 'the payment was refused — the guard is back').toBeUndefined();
    expect(res.status).toBe(201);
    expect(state.statements).toContain('INSERT mfg_sales_order_payments');
    expect(state.tables.mfg_sales_order_payments).toHaveLength(2);
    expect((body.payment as Row | undefined)?.amount_centi).toBe(225_00);
  });

  test('the balance the SO now carries is NEGATIVE — RM 400 order, RM 425 collected', async () => {
    seedOrder();
    await postPayment(225_00);
    const paid = state.tables.mfg_sales_order_payments
      .reduce((s, r) => s + Number(r.amount_centi ?? 0), 0);
    expect(paid).toBe(425_00);
    expect(soBalanceOf(400_00, paid)).toBe(-25_00);
  });

  /* THE REGRESSION THAT MATTERS. The bug was money reaching the ledger by way
     of item value, so the one thing this route may never do is move the order's
     own numbers. Recording a payment writes the payments ledger, the audit log
     and the AutoCount outbox — never mfg_sales_orders' totals and never a line.
     A future "recompute the header after a payment" would fail here. */
  test('records the money WITHOUT touching the order total or any line', async () => {
    seedOrder();
    const totalBefore = state.tables.mfg_sales_orders[0].total_revenue_centi;
    const localBefore = state.tables.mfg_sales_orders[0].local_total_centi;
    await postPayment(225_00);

    expect(state.statements.filter((s) => s.startsWith('UPDATE mfg_sales_orders '))).toEqual([]);
    expect(state.statements.filter((s) => s.includes('mfg_sales_order_items'))).toEqual([]);
    expect(state.statements.filter((s) => s.includes('mfg_so_price_overrides'))).toEqual([]);
    expect(state.tables.mfg_sales_orders[0].total_revenue_centi).toBe(totalBefore);
    expect(state.tables.mfg_sales_orders[0].local_total_centi).toBe(localBefore);
    expect(totalBefore).toBe(400_00);
  });

  test('an ordinary within-balance payment is unaffected', async () => {
    seedOrder();
    const res = await postPayment(50_00);
    expect(res.status).toBe(201);
    expect(state.tables.mfg_sales_order_payments).toHaveLength(2);
  });
});

/* PATCH /:docNo/payments/:id carried a hand-copied twin of the same guard, so
   an operator refused on POST could equally be refused on the correction. The
   route test above exercises POST; this covers the twin the same way the repo
   already pins absent checks (soCreateSlipOptionalWiring.test.ts) — by reading
   the source, because "the refusal is gone" is not a value any call returns. */
describe('no over-payment refusal survives anywhere in the SO router', () => {
  /* CODE, not the prose explaining it — the removal is documented at both call
     sites, and asserting over raw source would match those comments. */
  const code = routeSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  test("the string 'over_payment' appears in no handler", () => {
    expect(code).toContain('recordSoPaymentRow');   // the glob really loaded
    expect(code).not.toContain('over_payment');
  });

  test('and no handler re-derives the comparison that produced it', () => {
    /* The shape, not the label: `total > 0 && <sum> > total` is the guard even
       when somebody renames the error code. */
    expect(code).not.toMatch(/totalCenti\s*>\s*0\s*&&[^\n]*>\s*totalCenti/);
  });
});
