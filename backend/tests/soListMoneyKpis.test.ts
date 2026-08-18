/* soListMoneyKpis — the SO-list money KPI aggregate.
 *
 * The perf change replaces "page the WHOLE filtered set of SO rows in 1000-row
 * chunks and sum three int columns in JS" with ONE grouped PostgREST aggregate
 * (three server-side SUMs, no `.range()`). The whole point of the change is that
 * the numbers do NOT move, so this file's job is to PROVE byte-identity — the
 * aggregate fast path must equal the OLD paginateAll JS reduce on the same data,
 * not merely "run".
 *
 * How byte-identity is provable at all: `local_total_sen` is
 * `integer DEFAULT 0 NOT NULL` (backend/scripts/scm-schema/2990s-full-schema.sql),
 * and the view's `paid_total_sen` (= COALESCE(Σ payments,0)) and
 * `balance_sen_live` (= local_total − paid) are arithmetic over it, so none is
 * ever null when the view exposes it. SQL SUM skips nulls and the JS reduce
 * coalesces them to 0 — with no nulls present the two are the same number, and
 * SUM over zero rows is NULL which the parser coalesces to 0, matching the empty
 * reduce. This harness models exactly that: the fake aggregate SUMs the same
 * rows the fallback pages, so a divergence here is a divergence in the helper's
 * wiring — which is what we want the test to catch.
 *
 * The fake PostgREST builder is the shape used across the SCM route tests
 * (companyScopeSalesInvoiceMoney.test.ts): every method chains, `then` runs the
 * accumulated predicates. `.select()` sniffs `.sum()` to switch between the
 * aggregate row and the paged rows; `.range()` slices, and is COUNTED so a test
 * can assert the round-trip shape (fast path = zero range reads).
 */
import { describe, expect, test } from 'vitest';
import { soListMoneyKpis } from '../src/scm/routes/mfg-sales-orders';

type Row = Record<string, any>;
type Stats = { aggReads: number; rangeReads: number };

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private mode: 'agg' | 'rows' = 'rows';
  private rangeFrom = 0;
  private rangeTo = Number.MAX_SAFE_INTEGER;
  constructor(
    private rows: Row[],
    private stats: Stats,
    private aggEnabled: boolean,
    private rowsError: boolean,
  ) {}
  select(cols: string) { this.mode = cols.includes('.sum()') ? 'agg' : 'rows'; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  in(col: string, vals: readonly unknown[]) {
    const s = new Set((vals ?? []).map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
  gte(col: string, val: any) { this.preds.push((r) => r[col] >= val); return this; }
  lte(col: string, val: any) { this.preds.push((r) => r[col] <= val); return this; }
  // PostgREST or() — not exercised by these fixtures; a no-op keeps the fast
  // path and the fallback in lockstep when a caller does pass it.
  or() { return this; }
  range(from: number, to: number) { this.stats.rangeReads++; this.rangeFrom = from; this.rangeTo = to; return this; }
  private filtered(): Row[] { return this.rows.filter((r) => this.preds.every((p) => p(r))); }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    if (this.mode === 'agg') {
      this.stats.aggReads++;
      if (!this.aggEnabled) {
        return Promise.resolve({ data: null, error: { message: 'aggregate functions are not enabled' } }).then(res, rej);
      }
      const f = this.filtered();
      // SQL SUM: NULLs skipped; SUM over zero rows is NULL.
      const sum = (k: string) => (f.length === 0 ? null : f.reduce((s, r) => s + (r[k] == null ? 0 : Number(r[k])), 0));
      return Promise.resolve({
        data: [{ rev: sum('local_total_sen'), outLive: sum('balance_sen_live'), paid: sum('paid_total_sen') }],
        error: null,
      }).then(res, rej);
    }
    if (this.rowsError) {
      return Promise.resolve({ data: null, error: { message: 'read failed' } }).then(res, rej);
    }
    const page = this.filtered().slice(this.rangeFrom, this.rangeTo + 1);
    return Promise.resolve({ data: page, error: null }).then(res, rej);
  }
}

const makeSb = (rows: Row[], stats: Stats, aggEnabled: boolean, rowsError = false) => ({
  from: (_t: string) => new FakeQuery(rows, stats, aggEnabled, rowsError) as unknown as { select(c: string): unknown },
});

/* A representative filter closure of the same shape the handler builds:
   scope (`.in`) + company (`.eq`) + status (`.eq`) + so_date window
   (`.gte`/`.lte`). This is what the handler passes to soListMoneyKpis, and the
   helper applies it to BOTH paths, so the two cannot diverge on filtering. */
const filtersFor = (opts: { scopeIds?: string[]; company?: number; status?: string; from?: string; to?: string }) =>
  (q: any): any => {
    let qq = q;
    if (opts.scopeIds) qq = qq.in('salesperson_id', opts.scopeIds);
    if (opts.company != null) qq = qq.eq('company_id', opts.company);
    if (opts.status) qq = qq.eq('status', opts.status);
    if (opts.from) qq = qq.gte('so_date', opts.from);
    if (opts.to) qq = qq.lte('so_date', opts.to);
    return qq;
  };

const predFor = (opts: { scopeIds?: string[]; company?: number; status?: string; from?: string; to?: string }) =>
  (r: Row): boolean => {
    if (opts.scopeIds && !opts.scopeIds.map(String).includes(String(r.salesperson_id))) return false;
    if (opts.company != null && String(r.company_id) !== String(opts.company)) return false;
    if (opts.status && String(r.status) !== String(opts.status)) return false;
    if (opts.from && !(r.so_date >= opts.from)) return false;
    if (opts.to && !(r.so_date <= opts.to)) return false;
    return true;
  };

/* The OLD paginateAll JS reduce, verbatim — this is the number the change must
   reproduce. `?? balance_sen ?? 0` mirrors the handler's absent-view fallback. */
const oldReduce = (rows: Row[]) => {
  let revenueSen = 0, outstandingSen = 0, paidSen = 0;
  for (const m of rows) {
    revenueSen += m.local_total_sen ?? 0;
    outstandingSen += m.balance_sen_live ?? m.balance_sen ?? 0;
    paidSen += m.paid_total_sen ?? 0;
  }
  return { revenueSen, outstandingSen, paidSen };
};

/* Fixture: prod-shaped rows — local_total_sen / balance_sen_live /
   paid_total_sen all present and non-null (the NOT NULL / COALESCE guarantee),
   spread across two companies, several statuses and a date range. */
const FIXTURE: Row[] = [
  { doc_no: 'SO-1', salesperson_id: 's1', company_id: 1, status: 'CONFIRMED', so_date: '2026-08-01', local_total_sen: 100000, balance_sen: 100000, balance_sen_live: 40000, paid_total_sen: 60000 },
  { doc_no: 'SO-2', salesperson_id: 's1', company_id: 1, status: 'PROCESSING', so_date: '2026-08-05', local_total_sen: 250050, balance_sen: 250050, balance_sen_live: 250050, paid_total_sen: 0 },
  { doc_no: 'SO-3', salesperson_id: 's2', company_id: 1, status: 'CONFIRMED', so_date: '2026-08-10', local_total_sen: 33333, balance_sen: 33333, balance_sen_live: 0, paid_total_sen: 33333 },
  { doc_no: 'SO-4', salesperson_id: 's3', company_id: 2, status: 'CONFIRMED', so_date: '2026-08-12', local_total_sen: 999999, balance_sen: 999999, balance_sen_live: 500000, paid_total_sen: 499999 },
  { doc_no: 'SO-5', salesperson_id: 's2', company_id: 1, status: 'DELIVERED', so_date: '2026-07-20', local_total_sen: 12345, balance_sen: 12345, balance_sen_live: -5, paid_total_sen: 12350 },
];

describe('soListMoneyKpis — aggregate fast path is byte-identical to the old JS reduce', () => {
  test('sums the three view columns over the full company-scoped set', async () => {
    const stats: Stats = { aggReads: 0, rangeReads: 0 };
    const opts = { company: 1 };
    const res = await soListMoneyKpis(makeSb(FIXTURE, stats, true), filtersFor(opts));
    const expected = oldReduce(FIXTURE.filter(predFor(opts)));
    expect(res.error).toBeNull();
    expect(res.data).toEqual(expected);
  });

  test('honours status + so_date-window predicates exactly as the reduce would', async () => {
    const stats: Stats = { aggReads: 0, rangeReads: 0 };
    const opts = { company: 1, status: 'CONFIRMED', from: '2026-08-01', to: '2026-08-31' };
    const res = await soListMoneyKpis(makeSb(FIXTURE, stats, true), filtersFor(opts));
    expect(res.data).toEqual(oldReduce(FIXTURE.filter(predFor(opts))));
  });

  test('scope (salesperson) subset matches', async () => {
    const stats: Stats = { aggReads: 0, rangeReads: 0 };
    const opts = { scopeIds: ['s1', 's2'], company: 1 };
    const res = await soListMoneyKpis(makeSb(FIXTURE, stats, true), filtersFor(opts));
    expect(res.data).toEqual(oldReduce(FIXTURE.filter(predFor(opts))));
  });

  test('empty set → zeros (SUM over zero rows is NULL, coalesced to 0)', async () => {
    const stats: Stats = { aggReads: 0, rangeReads: 0 };
    const res = await soListMoneyKpis(makeSb(FIXTURE, stats, true), filtersFor({ company: 999 }));
    expect(res.data).toEqual({ revenueSen: 0, outstandingSen: 0, paidSen: 0 });
  });

  test('the fast path is ONE aggregate read and ZERO paged range reads', async () => {
    const stats: Stats = { aggReads: 0, rangeReads: 0 };
    await soListMoneyKpis(makeSb(FIXTURE, stats, true), filtersFor({ company: 1 }));
    expect(stats.aggReads).toBe(1);
    expect(stats.rangeReads).toBe(0);
  });
});

describe('soListMoneyKpis — fallback (aggregate unavailable) preserves the numbers', () => {
  test('falls back to paginateAll and returns byte-identical KPIs', async () => {
    const stats: Stats = { aggReads: 0, rangeReads: 0 };
    const opts = { company: 1, status: 'CONFIRMED' };
    const res = await soListMoneyKpis(makeSb(FIXTURE, stats, false), filtersFor(opts));
    expect(res.error).toBeNull();
    expect(res.data).toEqual(oldReduce(FIXTURE.filter(predFor(opts))));
    // it TRIED the aggregate, then paged
    expect(stats.aggReads).toBe(1);
    expect(stats.rangeReads).toBeGreaterThanOrEqual(1);
  });

  test('view lacks balance_sen_live → fallback uses balance_sen per row', async () => {
    // Rows with NO balance_sen_live key model the absent computed column: in
    // prod the aggregate would 500 on `balance_sen_live.sum()` and we fall
    // through to this path, which reads balance_sen. `?? balance_sen` must
    // carry it.
    const noLive = FIXTURE.map(({ balance_sen_live: _drop, ...r }) => r);
    const stats: Stats = { aggReads: 0, rangeReads: 0 };
    const opts = { company: 1 };
    const res = await soListMoneyKpis(makeSb(noLive, stats, false), filtersFor(opts));
    expect(res.data).toEqual(oldReduce(noLive.filter(predFor(opts))));
    // outstanding here is driven by balance_sen, so it equals revenue (gross)
    const scoped = noLive.filter(predFor(opts));
    const gross = scoped.reduce((s, r) => s + r.balance_sen, 0);
    expect(res.data!.outstandingSen).toBe(gross);
  });
});

describe('soListMoneyKpis — fast path and fallback agree, and errors never zero the KPIs', () => {
  test('same fixture + filters → identical numbers on both paths', async () => {
    for (const opts of [
      { company: 1 },
      { company: 1, status: 'CONFIRMED' },
      { company: 2 },
      { scopeIds: ['s2'], company: 1, from: '2026-08-01', to: '2026-08-31' },
    ]) {
      const fast = await soListMoneyKpis(makeSb(FIXTURE, { aggReads: 0, rangeReads: 0 }, true), filtersFor(opts));
      const slow = await soListMoneyKpis(makeSb(FIXTURE, { aggReads: 0, rangeReads: 0 }, false), filtersFor(opts));
      expect(fast.data).toEqual(slow.data);
      expect(fast.data).toEqual(oldReduce(FIXTURE.filter(predFor(opts))));
    }
  });

  test('aggregate disabled AND the paged read errors → error propagates, data is null (never wrong/zero KPIs)', async () => {
    const stats: Stats = { aggReads: 0, rangeReads: 0 };
    const res = await soListMoneyKpis(makeSb(FIXTURE, stats, false, true), filtersFor({ company: 1 }));
    expect(res.data).toBeNull();
    expect(res.error).not.toBeNull();
    expect(res.error!.message).toBe('read failed');
  });
});
