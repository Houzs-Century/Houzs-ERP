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
import poRouterSrc from '../routes/mfg-purchase-orders.ts?raw';
import libSrc from './outstanding-so-lines.ts?raw';

type Row = Record<string, unknown>;

const PGRST_MAX_ROWS = 1000;

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

const OLDEST = 'SO-000001';
const LINES: Row[] = [];
for (let d = 1; d <= 900; d++) {
  const docNo = `SO-${String(d).padStart(6, '0')}`;
  for (let l = 1; l <= 3; l++) {
    LINES.push({ id: `${docNo}-L${l}`, doc_no: docNo, cancelled: false, qty: 1, po_qty_picked: 0 });
  }
}
LINES.push({ id: 'SO-000001-LX', doc_no: OLDEST, cancelled: true, qty: 1, po_qty_picked: 0 });

const noScope = <T>(q: T): T => q;

describe('the read that feeds the From-SO picker', () => {
  test('reads every live line, not the newest 500 — the oldest order is offered', async () => {
    const counter = { reads: 0 };
    const { data, error } = await loadOutstandingSoLines<Row>(fakeSb(LINES, counter), noScope);
    expect(error).toBeNull();
    expect(data).toHaveLength(2_700);
    expect((data ?? []).some((r) => r.id === `${OLDEST}-L1`)).toBe(true);
    expect(counter.reads).toBe(3);
  });

  test('CONTROL — the pre-fix shape drops that same order from the same fixture', async () => {
    const counter = { reads: 0 };
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
    expect(libSrc).toContain(".order('doc_no', { ascending: false })");
    expect(libSrc).toContain(".order('id')");
  });

  test('the company predicate is applied INSIDE the page factory, so every page carries it', async () => {
    const seen: number[] = [];
    const scoped = <T>(q: T): T => { seen.push(1); return q; };
    await loadOutstandingSoLines<Row>(fakeSb(LINES, { reads: 0 }), scoped);
    expect(seen).toHaveLength(3);
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
