// Effective-dated SELLING price — write + read timeline (Pricing "Option B",
// ph.2). Covers the two new /mfg-products/:id/price-changes handlers:
//   • append one immutable history row,
//   • AUTO-BASELINE — the first future-dated price for a product with no history
//     also snapshots the current flat price at today, so the timeline reads
//     "today = current, <future> = new",
//   • company scoping — a caller cannot append to (or read) another company's
//     product, and an unresolved company refuses rather than acting globally,
//   • the read timeline returns rows DESC + the current as-of price + pending-next.
//
// Same bare-Hono harness shape as companyScopeMastersConfig.test.ts: middleware
// injects a fake scm supabase client + company/user context and mounts the
// EXPORTED handlers directly (the supabaseAuth bridge can't run here). The fake
// PostgREST builder here is a superset of that file's — it also honours lte/gt +
// order/limit so the resolver queries (product-pricing-history.ts) actually run.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { createPriceChangeHandler, listPriceChangesHandler } from '../src/scm/routes/mfg-products';
import { todayMyt } from '../src/scm/lib/my-time';

const CO_A = 1; // HOUZS
const CO_B = 2; // 2990
const FUTURE = '2099-01-01';
const TODAY = todayMyt();

type Row = Record<string, any>;

/* Fake PostgREST builder. Chains like supabase-js; unknown tables read empty.
   Tracks eq/lte/gt predicates, order specs and limit so a select resolves the
   same rows the real query would. Dates are YYYY-MM-DD strings, so lexicographic
   comparison is the correct calendar order. */
class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private orders: Array<{ col: string; asc: boolean }> = [];
  private limitN: number | null = null;
  private op: 'select' | 'update' | 'delete' | 'insert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  private idSeq = { n: 0 };
  constructor(private rows: Row[], private table: string, private seq: { n: number }) {
    this.idSeq = seq;
  }
  select() { return this; }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orders.push({ col, asc: opts?.ascending !== false });
    return this;
  }
  limit(n: number) { this.limitN = n; return this; }
  range() { return this; }
  ilike() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(p: Row | Row[]) {
    this.op = 'insert';
    const arr = Array.isArray(p) ? p : [p];
    // The DB owns id + created_at; stamp them here so the handler can read them back.
    this.inserted = arr.map((r) => ({
      id: r.id ?? `row-${++this.idSeq.n}`,
      created_at: r.created_at ?? new Date(2020, 0, 1, 0, 0, this.idSeq.n).toISOString(),
      ...r,
    }));
    return this;
  }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: unknown[]) {
    const s = new Set((vals ?? []).map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
  lte(col: string, val: unknown) { this.preds.push((r) => r[col] <= val); return this; }
  gte(col: string, val: unknown) { this.preds.push((r) => r[col] >= val); return this; }
  gt(col: string, val: unknown) { this.preds.push((r) => r[col] > val); return this; }
  lt(col: string, val: unknown) { this.preds.push((r) => r[col] < val); return this; }
  not() { return this; }
  like() { return this; }
  is() { return this; }
  or() { return this; }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    let hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    for (const o of [...this.orders].reverse()) {
      hit = hit.sort((a, b) => {
        const av = a[o.col], bv = b[o.col];
        if (av === bv) return 0;
        const cmp = av < bv ? -1 : 1;
        return o.asc ? cmp : -cmp;
      });
    }
    if (this.limitN != null) hit = hit.slice(0, this.limitN);
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() {
    const h = this.run();
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

function harness(tables: Record<string, Row[]>, companyId: number | undefined) {
  const seq = { n: 0 };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), t, seq),
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('companyId' as never, companyId as never);
    c.set('user' as never, { id: 'SYSTEM-STAFF-UUID' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', email: 't@houzs.my', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.post('/mfg-products/:id/price-changes', createPriceChangeHandler as never);
  app.get('/mfg-products/:id/price-changes', listPriceChangesHandler as never);
  return { app };
}

const postChange = (app: Hono, id: string, body: Row) =>
  app.request(`/mfg-products/${id}/price-changes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const products = (): Row[] => [
  { id: 'p-a', code: 'SKU-A', company_id: CO_A, sell_price_sen: 10000 }, // RM100
  { id: 'p-b', code: 'SKU-B', company_id: CO_B, sell_price_sen: 30000 }, // RM300
];

// ── Append ───────────────────────────────────────────────────────────────────
describe('POST /mfg-products/:id/price-changes — append', () => {
  test('appends one row for the active company', async () => {
    const t = { mfg_products: products(), mfg_product_price_history: [] as Row[] };
    const res = await postChange(harness(t, CO_A).app, 'p-a', { effectiveFrom: TODAY, sellPriceSen: 12000 });
    expect(res.status).toBe(201);
    const j = await res.json() as Row;
    expect(j.ok).toBe(true);
    // Today-dated (not future) → no auto-baseline; exactly one row lands.
    expect(j.baselined).toBe(false);
    const hist = t.mfg_product_price_history;
    expect(hist.length).toBe(1);
    expect(hist[0]).toMatchObject({
      company_id: CO_A, product_code: 'SKU-A', sell_price_sen: 12000, effective_from: TODAY,
    });
    // Attribution records the REAL caller (name), not the pinned system uuid.
    expect(hist[0].created_by).toBe('Tester');
  });

  test('rejects a missing / malformed effective date', async () => {
    const t = { mfg_products: products(), mfg_product_price_history: [] as Row[] };
    const res = await postChange(harness(t, CO_A).app, 'p-a', { effectiveFrom: 'soon', sellPriceSen: 12000 });
    expect(res.status).toBe(400);
    expect((await res.json() as Row).error).toBe('effective_from_required');
    expect(t.mfg_product_price_history.length).toBe(0);
  });

  test('rejects a missing / negative / non-integer price', async () => {
    const t = { mfg_products: products(), mfg_product_price_history: [] as Row[] };
    for (const bad of [undefined, -1, 12000.5]) {
      const res = await postChange(harness(t, CO_A).app, 'p-a', { effectiveFrom: TODAY, sellPriceSen: bad as never });
      expect(res.status).toBe(400);
      expect((await res.json() as Row).error).toBe('sell_price_required');
    }
    expect(t.mfg_product_price_history.length).toBe(0);
  });
});

// ── Auto-baseline ──────────────────────────────────────────────────────────────
describe('POST /mfg-products/:id/price-changes — auto-baseline', () => {
  test('first FUTURE price with no history also snapshots today = current', async () => {
    const t = { mfg_products: products(), mfg_product_price_history: [] as Row[] };
    const res = await postChange(harness(t, CO_A).app, 'p-a', { effectiveFrom: FUTURE, sellPriceSen: 20000 });
    expect(res.status).toBe(201);
    expect((await res.json() as Row).baselined).toBe(true);
    const hist = t.mfg_product_price_history;
    expect(hist.length).toBe(2);
    // Baseline row: today, snapshot of the current flat price (RM100).
    const baseline = hist.find((r) => r.effective_from === TODAY)!;
    expect(baseline).toBeTruthy();
    expect(baseline.sell_price_sen).toBe(10000);
    // Scheduled row: the future date, the new price (RM200).
    const scheduled = hist.find((r) => r.effective_from === FUTURE)!;
    expect(scheduled.sell_price_sen).toBe(20000);
  });

  test('does NOT baseline again once history exists', async () => {
    const t = {
      mfg_products: products(),
      mfg_product_price_history: [
        { id: 'h0', company_id: CO_A, product_code: 'SKU-A', sell_price_sen: 10000, effective_from: TODAY },
      ] as Row[],
    };
    const res = await postChange(harness(t, CO_A).app, 'p-a', { effectiveFrom: FUTURE, sellPriceSen: 25000 });
    expect(res.status).toBe(201);
    expect((await res.json() as Row).baselined).toBe(false);
    // Only the scheduled row is added — no second today-dated baseline.
    expect(t.mfg_product_price_history.length).toBe(2);
    expect(t.mfg_product_price_history.filter((r) => r.effective_from === TODAY).length).toBe(1);
  });

  test('a today/past-dated first price is not baselined (it IS the current row)', async () => {
    const t = { mfg_products: products(), mfg_product_price_history: [] as Row[] };
    const res = await postChange(harness(t, CO_A).app, 'p-a', { effectiveFrom: TODAY, sellPriceSen: 15000 });
    expect(res.status).toBe(201);
    expect((await res.json() as Row).baselined).toBe(false);
    expect(t.mfg_product_price_history.length).toBe(1);
  });
});

// ── Company scope ──────────────────────────────────────────────────────────────
describe('POST /mfg-products/:id/price-changes — company scope', () => {
  test("A cannot schedule a price on B's product, and B gets no row", async () => {
    const t = { mfg_products: products(), mfg_product_price_history: [] as Row[] };
    const res = await postChange(harness(t, CO_A).app, 'p-b', { effectiveFrom: FUTURE, sellPriceSen: 99900 });
    expect(res.status).toBe(404);
    expect(t.mfg_product_price_history.length).toBe(0);
  });

  test('an unresolved company refuses rather than appending globally', async () => {
    const t = { mfg_products: products(), mfg_product_price_history: [] as Row[] };
    const res = await postChange(harness(t, undefined).app, 'p-a', { effectiveFrom: FUTURE, sellPriceSen: 20000 });
    expect(res.status).toBe(409);
    expect((await res.json() as Row).error).toBe('company_unresolved');
    expect(t.mfg_product_price_history.length).toBe(0);
  });
});

// ── Read timeline ──────────────────────────────────────────────────────────────
describe('GET /mfg-products/:id/price-changes — timeline', () => {
  test('returns rows DESC + current as-of price + pending-next', async () => {
    const t = {
      mfg_products: products(),
      mfg_product_price_history: [
        { id: 'h1', company_id: CO_A, product_code: 'SKU-A', sell_price_sen: 10000, effective_from: TODAY, created_at: '2020-01-01T00:00:00Z' },
        { id: 'h2', company_id: CO_A, product_code: 'SKU-A', sell_price_sen: 20000, effective_from: FUTURE, created_at: '2020-01-02T00:00:00Z' },
      ] as Row[],
    };
    const res = await harness(t, CO_A).app.request('/mfg-products/p-a/price-changes');
    expect(res.status).toBe(200);
    const j = await res.json() as Row;
    expect(j.history.map((r: Row) => r.effective_from)).toEqual([FUTURE, TODAY]); // newest first
    expect(j.currentSellPriceSen).toBe(10000); // as-of today
    expect(j.pending).toEqual({ sellPriceSen: 20000, effectiveFrom: FUTURE });
  });

  test("does not read another company's timeline", async () => {
    const t = {
      mfg_products: products(),
      mfg_product_price_history: [
        { id: 'hb', company_id: CO_B, product_code: 'SKU-B', sell_price_sen: 30000, effective_from: TODAY },
      ] as Row[],
    };
    const res = await harness(t, CO_A).app.request('/mfg-products/p-b/price-changes');
    expect(res.status).toBe(404);
  });
});
