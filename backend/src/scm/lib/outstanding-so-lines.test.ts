// ----------------------------------------------------------------------------
// A SALES ORDER THAT NEEDS A PURCHASE ORDER MUST BE ON THE PICKER.
//
// `GET /mfg-purchase-orders/outstanding-so-items` is the only source the desktop
// From-SO picker and the mobile convert wizard read. It asked for the company's
// live SO lines behind a `.limit(500)` ordered `doc_no` DESC and applied every
// filter that decides the answer afterwards in JavaScript — so which lines could
// be offered at all was settled by document number, before the question "does
// this line still need ordering?" was ever asked.
//
// The size is measured, not assumed: company 1 held 15,050 live sales-order
// lines on 2026-09-08 (docs/bugs/0677). 500 of 15,050 is 3.3%.
//
// THE CONTROL IS PART OF THE TEST. `losesTheOldWay` replays the pre-fix shape
// against the SAME fixture and asserts it drops the line — without it, "the
// paged read found every row" would pass just as happily against a fake that
// never had a ceiling, which is the vacuous-verdict trap.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';

import { loadOutstandingSoLines, OUTSTANDING_SO_SELECT } from './outstanding-so-lines';
// Source text of both files, so the WIRING is asserted too — the old read looked
// fine and was wrong about which rows it had. Same device as
// outstanding-po-lines.test.ts, and for the same reason.
import poRouterSrc from '../routes/mfg-purchase-orders.ts?raw';
import libSrc from './outstanding-so-lines.ts?raw';

type Row = Record<string, unknown>;

/* THE FAKE ENFORCES POSTGREST'S REAL ROW CEILING — the point of the harness.
   A live PostgREST returns at most `db-max-rows` per response, drops the rest,
   and reports NOTHING. A fake that hands back everything makes an un-paged read
   look correct here while it is short in production. Same device as
   mfg-purchase-orders.binding-cap.test.ts. */
const PGRST_MAX_ROWS = 1000;

/* TIES COME BACK IN WHATEVER ORDER THE PLANNER PRODUCED, and each request is
   its own plan. The fake reproduces that by breaking ties differently per
   query, which is the only way a test can see what an INCOMPLETE sort key costs
   a `.range()` window: with a stable fake, a missing tie-break is invisible and
   the assertion below would pass on the broken code. Deterministic — a fixed
   rotation keyed on the request number, so a failure reproduces. */
function fakeSb(rows: Row[], counter: { reads: number }) {
  class Q {
    private rows: Row[];
    private orders: Array<{ col: string; asc: boolean }> = [];
    private window: [number, number] | null = null;
    private capped: number | null = null;
    private plan = 0;
    constructor(rs: Row[]) { this.rows = [...rs]; }
    select(_cols?: string) { return this; }
    eq(col: string, val: unknown) { this.rows = this.rows.filter((r) => r[col] === val); return this; }
    order(col: string, o?: { ascending?: boolean }) { this.orders.push({ col, asc: o?.ascending !== false }); return this; }
    range(from: number, to: number) { this.window = [from, to]; return this; }
    limit(n: number) { this.capped = n; return this; }
    private sorted(): Row[] {
      const rot = this.plan;
      return this.rows
        .map((r, i) => ({ r, i }))
        .sort((a, b) => {
          for (const { col, asc } of this.orders) {
            const av = a.r[col] as string; const bv = b.r[col] as string;
            if (av === bv) continue;
            return asc ? (av < bv ? -1 : 1) : (av < bv ? 1 : -1);
          }
          // Unordered pair: this plan's arbitrary answer, not insertion order.
          return ((a.i + rot) % 5) - ((b.i + rot) % 5);
        })
        .map((x) => x.r);
    }
    then<T>(onF: (v: { data: Row[]; error: null }) => T) {
      counter.reads += 1;
      this.plan = counter.reads;
      let out = this.sorted();
      if (this.window) out = out.slice(this.window[0], this.window[1] + 1);
      if (this.capped != null) out = out.slice(0, this.capped);
      return Promise.resolve({ data: out.slice(0, PGRST_MAX_ROWS), error: null as null })
        .then(onF);
    }
  }
  return { from: () => new Q(rows) };
}

/* 2,700 live lines across 900 sales orders, THREE lines each — the shape that
   matters, because `doc_no` is NOT unique and the old order was `doc_no` alone.
   Three, not five: 1,000 (the page size) divides by five, so five-line orders
   would put every page boundary exactly on a document edge and no tie would
   ever straddle one — the fixture would then pass with or without the
   tie-break, which is the fixture proving nothing.
   `SO-000001` is the OLDEST document number, so it sorts LAST under `doc_no`
   DESC and is exactly the line the 500-row window could never reach. */
const OLDEST = 'SO-000001';
const LINES: Row[] = [];
for (let d = 1; d <= 900; d++) {
  const docNo = `SO-${String(d).padStart(6, '0')}`;
  for (let l = 1; l <= 3; l++) {
    LINES.push({ id: `${docNo}-L${l}`, doc_no: docNo, cancelled: false, qty: 1, po_qty_picked: 0 });
  }
}
// A cancelled line, to prove the SQL filter that DOES belong in the read survived.
LINES.push({ id: 'SO-000001-LX', doc_no: OLDEST, cancelled: true, qty: 1, po_qty_picked: 0 });

const noScope = <T>(q: T): T => q;

describe('the read that feeds the From-SO picker', () => {
  test('reads every live line, not the newest 500 — the oldest order is offered', async () => {
    const counter = { reads: 0 };
    const { data, error } = await loadOutstandingSoLines<Row>(fakeSb(LINES, counter), noScope);
    expect(error).toBeNull();
    expect(data).toHaveLength(2_700);
    // The consequence, in the operator's terms: this order can be turned into a
    // purchase order again.
    expect((data ?? []).some((r) => r.id === `${OLDEST}-L1`)).toBe(true);
    // 2,700 live rows in 1,000-row windows is three requests, the last short.
    expect(counter.reads).toBe(3);
  });

  test('CONTROL — the pre-fix shape drops that same order from the same fixture', async () => {
    const counter = { reads: 0 };
    // Byte-for-byte the read this module replaced: one request, `.limit(500)`,
    // ordered by `doc_no` alone.
    const sb = fakeSb(LINES, counter);
    const { data } = await sb.from()
      .select(OUTSTANDING_SO_SELECT)
      .eq('cancelled', false)
      .order('doc_no', { ascending: false })
      .limit(500);
    expect(data).toHaveLength(500);
    expect(data.some((r) => r.id === `${OLDEST}-L1`)).toBe(false);
  });

  test('the cancelled line is still excluded — the fix widened the window, not the filter', async () => {
    const { data } = await loadOutstandingSoLines<Row>(fakeSb(LINES, { reads: 0 }), noScope);
    expect((data ?? []).some((r) => r.id === 'SO-000001-LX')).toBe(false);
  });

  test('no line is repeated or lost across page boundaries — the order is TOTAL', async () => {
    const { data } = await loadOutstandingSoLines<Row>(fakeSb(LINES, { reads: 0 }), noScope);
    const ids = (data ?? []).map((r) => r.id as string);
    expect(new Set(ids).size).toBe(ids.length);
    /* `doc_no` alone is not a total order — three lines share each one — so a
       page boundary landing inside a document is where a repeat or a drop would
       appear. `id` is the tie-break that makes the window coherent. */
    expect(libSrc).toContain(".order('doc_no', { ascending: false })");
    expect(libSrc).toContain(".order('id')");
  });

  test('the company predicate is applied INSIDE the page factory, so every page carries it', async () => {
    const seen: number[] = [];
    const scoped = <T>(q: T): T => { seen.push(1); return q; };
    await loadOutstandingSoLines<Row>(fakeSb(LINES, { reads: 0 }), scoped);
    expect(seen).toHaveLength(3);              // once per page, not once per call
  });
});

describe('WIRING — a guard nothing calls is the failure mode this repo pays for', () => {
  test('the handler reaches the shared reader and carries no cap of its own', () => {
    const start = poRouterSrc.indexOf("mfgPurchaseOrders.get('/outstanding-so-items'");
    const end = poRouterSrc.indexOf("mfgPurchaseOrders.get('/so-line-candidates'", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const handler = poRouterSrc.slice(start, end);
    expect(handler.length).toBeGreaterThan(500);
    /* Strip comments first. The handler DESCRIBES the cap it removed, and a raw
       substring match on the prose would fail while the code is right — which
       teaches the next person to delete the provenance to get green. */
    const code = handler.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\.limit\(/);
    expect(code).toContain('loadOutstandingSoLines');
    expect(code).toContain('(q) => scopeToCompany(q, c)');
  });

  test('and the module it moved to caps nothing either', () => {
    expect(libSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''))
      .not.toMatch(/\.limit\(/);
  });
});
