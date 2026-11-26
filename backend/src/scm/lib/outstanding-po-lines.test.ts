// ----------------------------------------------------------------------------
// The three mechanisms that made an UNRECEIVED Purchase Order read as fully
// received in the GRN picker (owner, 2026-08-17), each pinned so it cannot come
// back — plus the wiring assertions, because a guard nothing calls is the
// failure mode this repo keeps paying for.
//
// The bug was not one of the three. It was that all three were SILENT: whichever
// one fired, the screen said "every line has been received". So the last suite
// here is about the REPORT, not the read.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import {
  PO_DEAD_FOR_RECEIPT, poDeadForReceiptSql, pageWithTruncation, parsePoIdScope,
  explainOutstanding, remainingOf, loadOutstandingPoLines,
  OUTSTANDING_PAGE, OUTSTANDING_MAX_PAGES,
  type CountableRow,
} from './outstanding-po-lines';
import { scopeToCompany, type CompanyScopeCtx } from './companyScope';
import grnRouterSrc from '../routes/grns.ts?raw';
import libSrc from './outstanding-po-lines.ts?raw';

const row = (poId: string, qty: number, received: number, status = 'SUBMITTED', onHold = false): CountableRow => ({
  purchase_order_id: poId, qty, received_qty: received,
  po: { po_number: `PO-${poId}`, status, on_hold: onHold },
});

const isReceivable = (po: { status?: string | null; on_hold?: boolean | null } | null): boolean =>
  po?.on_hold !== true && (po?.status === 'SUBMITTED' || po?.status === 'PARTIALLY_RECEIVED');

describe('MECHANISM 1 — the read is paged, and says so when it stops early', () => {
  const source = (total: number) => {
    let calls = 0;
    return {
      get calls() { return calls; },
      query: (from: number, to: number) => {
        calls += 1;
        const rows = [];
        for (let i = from; i <= to && i < total; i++) rows.push({ id: i });
        return Promise.resolve({ data: rows, error: null });
      },
    };
  };

  test('a set SMALLER than one page is read whole and is NOT flagged truncated', async () => {
    const s = source(12);
    const r = await pageWithTruncation<{ id: number }>(s.query);
    expect(r.data).toHaveLength(12);
    expect(r.truncated).toBe(false);
    expect(s.calls).toBe(1);
  });

  test('a set LARGER than the old 500 cap is now read in full', async () => {
    const s = source(1_400);
    const r = await pageWithTruncation<{ id: number }>(s.query);
    expect(r.data).toHaveLength(1_400);
    expect(r.truncated).toBe(false);
    expect(s.calls).toBe(2);
  });

  test('a set that EXHAUSTS the ceiling reports truncated:true rather than passing a short list off as complete', async () => {
    const ceiling = OUTSTANDING_PAGE * OUTSTANDING_MAX_PAGES;
    const s = source(ceiling + 1);
    const r = await pageWithTruncation<{ id: number }>(s.query);
    expect(r.data).toHaveLength(ceiling);
    expect(r.truncated).toBe(true);
  });

  test('a read error is returned, never folded into an empty page', async () => {
    const r = await pageWithTruncation<{ id: number }>(() =>
      Promise.resolve({ data: null, error: { message: 'boom' } }));
    expect(r.data).toBeNull();
    expect(r.error?.message).toBe('boom');
    expect(r.truncated).toBe(false);
  });
});

describe('MECHANISM 2 — the SQL status filter is the form already proven in production', () => {
  test('only DRAFT and CANCELLED are excluded in SQL; the exact set stays the JS gate', () => {
    expect([...PO_DEAD_FOR_RECEIPT]).toEqual(['DRAFT', 'CANCELLED']);
  });

  test('the quoted in-list matches mrp.ts sqlNotInList byte for byte', () => {
    expect(poDeadForReceiptSql()).toBe('("DRAFT","CANCELLED")');
  });

  test('the read uses .not(…in…) on the EMBEDDED alias, not a bare column', () => {
    expect(libSrc).toContain(".not('po.status', 'in', poDeadForReceiptSql())");
  });

  test('the JS gate is still the authority on the exact receivable set', () => {
    expect(libSrc).toContain('.filter((r) => isReceivable(r.po))');
  });

  test('the route hands its OWN receivable predicate in, so it stays the authority', () => {
    expect(grnRouterSrc).toContain('isReceivable: isReceivablePo');
  });
});

describe('MECHANISM 3 — the ?poId scope reaches SQL', () => {
  test('a comma list parses, de-duplicates and trims', () => {
    expect(parsePoIdScope('a, b ,a,,c')).toEqual(['a', 'b', 'c']);
  });

  test('no parameter means the OPEN picker — a legitimate entry point, not a scope of nothing', () => {
    expect(parsePoIdScope(undefined)).toEqual([]);
    expect(parsePoIdScope('')).toEqual([]);
  });

  test('the read applies the scope as a SQL predicate on the line table', () => {
    expect(libSrc).toContain("q = q.in('purchase_order_id', requestedPoIds)");
  });

  test('the route reads the parameter at all — it used to be browser-only', () => {
    expect(grnRouterSrc).toContain("parsePoIdScope(c.req.query('poId'))");
  });

  test('the window is ordered by the LINE key, not by the parent id', () => {
    expect(libSrc).not.toContain("order('purchase_order_id', { ascending: false })");
    expect(libSrc).toContain("q.order('id').range(from, to)");
    expect(grnRouterSrc).not.toContain("order('purchase_order_id', { ascending: false })");
  });

  test('the old silent cap is gone from this handler', () => {
    const start = grnRouterSrc.indexOf("grns.get('/outstanding-po-items'");
    const end = grnRouterSrc.indexOf('export async function grnLineDownstream', start);
    const handler = grnRouterSrc.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(handler.length).toBeGreaterThan(500);
    const code = handler.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\.limit\(/);
    expect(code).toContain('loadOutstandingPoLines');
    expect(libSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''))
      .not.toMatch(/\.limit\(/);
  });
});

describe('remainingOf', () => {
  test('a null received_qty counts as nothing received', () => {
    expect(remainingOf({ qty: 5, received_qty: null })).toBe(5);
  });
  test('an over-received line is not outstanding', () => {
    expect(remainingOf({ qty: 5, received_qty: 7 })).toBe(-2);
  });
});

describe('THE REPORT — an empty answer must be able to say WHY', () => {
  test('the unscoped picker reports no scoped POs and no unknowns', () => {
    const s = explainOutstanding([], [row('p1', 3, 0)], new Map(), false, isReceivable);
    expect(s.pos).toEqual([]);
    expect(s.unknownPoIds).toEqual([]);
    expect(s.scanned).toBe(1);
  });

  test('a FULLY RECEIVED PO is reported receivable with ZERO outstanding lines — the one case entitled to say "done"', () => {
    const s = explainOutstanding(
      ['p1'], [row('p1', 5, 5, 'PARTIALLY_RECEIVED')], new Map(), false, isReceivable,
    );
    expect(s.pos).toEqual([{
      poId: 'p1', poDocNo: 'PO-p1', status: 'PARTIALLY_RECEIVED', onHold: false,
      receivable: true, candidateLines: 1, outstandingLines: 0,
    }]);
  });

  test('a PARTLY received PO still counts its outstanding line', () => {
    const s = explainOutstanding(
      ['p1'], [row('p1', 5, 5), row('p1', 4, 1)], new Map(), false, isReceivable,
    );
    expect(s.pos[0]!.candidateLines).toBe(2);
    expect(s.pos[0]!.outstandingLines).toBe(1);
  });

  test('a RECEIVED PO is reported NOT receivable — its status, not a completion claim', () => {
    const s = explainOutstanding(
      ['p1'], [row('p1', 5, 5, 'RECEIVED')], new Map(), false, isReceivable,
    );
    expect(s.pos[0]!.receivable).toBe(false);
    expect(s.pos[0]!.status).toBe('RECEIVED');
  });

  test('a HELD PO still reads SUBMITTED and is reported NOT receivable', () => {
    const s = explainOutstanding(
      ['p1'], [row('p1', 5, 0, 'SUBMITTED', true)], new Map(), false, isReceivable,
    );
    expect(s.pos[0]!.status).toBe('SUBMITTED');
    expect(s.pos[0]!.onHold).toBe(true);
    expect(s.pos[0]!.receivable).toBe(false);
  });

  test('the hold marker travels from the HEADER read when the PO produced no lines', () => {
    const s = explainOutstanding(
      ['p1'], [], new Map([['p1', { poDocNo: 'PO-9', status: 'SUBMITTED', onHold: true }]]), false, isReceivable,
    );
    expect(s.pos[0]!.onHold).toBe(true);
    expect(s.pos[0]!.receivable).toBe(false);
  });

  test('a DRAFT PO produces no candidate rows, so its status comes from the HEADER read', () => {
    const s = explainOutstanding(
      ['p1'], [], new Map([['p1', { poDocNo: 'PO-9', status: 'DRAFT', onHold: false }]]), false, isReceivable,
    );
    expect(s.pos).toEqual([{
      poId: 'p1', poDocNo: 'PO-9', status: 'DRAFT', onHold: false,
      receivable: false, candidateLines: 0, outstandingLines: 0,
    }]);
    expect(s.unknownPoIds).toEqual([]);
  });

  test('a PO this company does not hold is UNKNOWN, never silently absent', () => {
    const s = explainOutstanding(['nope'], [], new Map(), false, isReceivable);
    expect(s.unknownPoIds).toEqual(['nope']);
    expect(s.pos).toEqual([]);
  });

  test('truncation rides through to the report', () => {
    expect(explainOutstanding([], [], new Map(), true, isReceivable).truncated).toBe(true);
  });

  test('the caller\'s predicate is what decides receivable — this module holds no copy', () => {
    const submittedOnly = (po: { status?: string | null } | null) => po?.status === 'SUBMITTED';
    const r = explainOutstanding(
      ['p1'], [row('p1', 5, 0, 'PARTIALLY_RECEIVED')], new Map(), false, submittedOnly,
    );
    expect(r.pos[0]!.receivable).toBe(false);
  });

  test('the read hands the caller\'s predicate to the report, not a local copy', () => {
    expect(libSrc).toContain('explainOutstanding(requestedPoIds, candidates, headerStatuses, truncated, isReceivable)');
  });

  test('the route hands its own COMPANY predicate in — the only tenant boundary', () => {
    expect(grnRouterSrc).toContain('scopeQuery: (q) => scopeToCompany(q, c)');
  });

  test('the route actually returns the scope — a report nobody sends explains nothing', () => {
    expect(grnRouterSrc).toContain('c.json({ items: outstanding, scope })');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   THE WHOLE READ, against a recording PostgREST stand-in.
   *Carried over from `outstanding-po-items.test.ts` (#2367), which tested the
   parallel module main landed for this same bug; that module was deleted in the
   merge because only one of the two could be the endpoint's read, and leaving the
   loser in place would have left its tests passing about code with no callers.*

   These are BEHAVIOURAL versions of the three source-text assertions above. The
   note that suite carried is the reason they are worth having twice over: *"There
   is no assertion available on 'did it return everything' that a `.limit()` would
   fail — only the query itself says."* A recorder makes the statement itself
   assertable, so a `.limit()` reintroduced anywhere in the chain fails here even
   if the module's prose still says there is none.

   `fake-postgrest` cannot help: the assertions are about an embedded-resource
   filter (`po.status` through an `!inner` join) and about paging, neither of which
   it models — and a fake that quietly ignored the status filter would report a
   pass for the exact statement shape that caused the incident.
   ──────────────────────────────────────────────────────────────────────────── */
describe('loadOutstandingPoLines — the statement, recorded', () => {
  type Call = { method: string; args: unknown[] };

  const line = (over: Record<string, unknown> = {}) => ({
    id: 'poi-1', purchase_order_id: 'po-1', qty: 1, received_qty: 0,
    po: { id: 'po-1', po_number: 'HC-PO-2608-001', status: 'SUBMITTED' },
    ...over,
  });

  function recordingSb(pages: unknown[][], opts: { error?: { message: string } } = {}) {
    const calls: Call[] = [];
    const tables: string[] = [];
    let page = 0;
    const from = (table: string) => {
      tables.push(table);
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'not', 'order', 'limit']) {
        b[m] = (...args: unknown[]) => {
          calls.push({ method: m, args: [table, ...args] });
          return table === 'purchase_orders'
            ? Object.assign(b, { then: (r: (v: unknown) => unknown) => r({ data: [], error: null }) })
            : b;
        };
      }
      b.range = (lo: number, hi: number) => {
        calls.push({ method: 'range', args: [table, lo, hi] });
        if (opts.error) return Promise.resolve({ data: null, error: opts.error });
        const rows = pages[page] ?? [];
        page += 1;
        return Promise.resolve({ data: rows, error: null });
      };
      return b;
    };
    return { sb: { from } as unknown as Parameters<typeof loadOutstandingPoLines>[0]['sb'], calls, tables };
  }

  const used = (calls: Call[], method: string) => calls.filter((x) => x.method === method);
  const scopeQuery = (c: CompanyScopeCtx) => <Q,>(q: Q): Q => scopeToCompany(q, c);
  const activeCompany: CompanyScopeCtx = { get: (k: string) => (k === 'companyId' ? 1 : undefined) };

  const run = (sb: ReturnType<typeof recordingSb>['sb'], over: Partial<{
    requestedPoIds: string[]; ctx: CompanyScopeCtx;
  }> = {}) => loadOutstandingPoLines({
    sb,
    scopeQuery: scopeQuery(over.ctx ?? activeCompany),
    requestedPoIds: over.requestedPoIds ?? [],
    isReceivable,
  });

  test('never asks for a fixed number of rows — that is what hid 168 lines', async () => {
    const { sb, calls } = recordingSb([[line()]]);
    await run(sb);
    expect(used(calls, 'limit')).toHaveLength(0);
    expect(used(calls, 'range')).not.toHaveLength(0);
  });

  test('filters the parent status in the QUERY, through the !inner embed', async () => {
    const { sb, calls } = recordingSb([[line()]]);
    await run(sb);
    const f = used(calls, 'not').find((x) => x.args[1] === 'po.status');
    expect(f).toBeDefined();
    expect(f?.args[2]).toBe('in');
    expect(f?.args[3]).toBe('("DRAFT","CANCELLED")');
  });

  test('sorts by a TOTAL order, so a paged read cannot repeat or skip a row', async () => {
    const { sb, calls } = recordingSb([[line()]]);
    await run(sb);
    const cols = used(calls, 'order').map((x) => x.args[1]);
    expect(cols).toEqual(['id']);
    expect(cols).not.toContain('purchase_order_id');
  });

  test('reads EVERY page, not just the first', async () => {
    const full = Array.from({ length: OUTSTANDING_PAGE }, (_, i) => line({ id: `a-${i}` }));
    const { sb, calls } = recordingSb([full, [line({ id: 'b-0' })]]);
    const r = await run(sb);
    const ranges = used(calls, 'range');
    expect(ranges).toHaveLength(2);
    expect(ranges[0]!.args).toEqual(['purchase_order_items', 0, OUTSTANDING_PAGE - 1]);
    expect(ranges[1]!.args).toEqual(['purchase_order_items', OUTSTANDING_PAGE, OUTSTANDING_PAGE * 2 - 1]);
    expect(r.error).toBeNull();
    if (r.error === null) expect(r.rows).toHaveLength(OUTSTANDING_PAGE + 1);
  });

  test('still drops a line whose balance is zero, and an over-received one', async () => {
    const { sb } = recordingSb([[
      line({ id: 'open', qty: 2, received_qty: 1 }),
      line({ id: 'done', qty: 1, received_qty: 1 }),
      line({ id: 'over', qty: 1, received_qty: 3 }),
      line({ id: 'null-received', qty: 4, received_qty: null }),
    ]]);
    const r = await run(sb);
    expect(r.error).toBeNull();
    if (r.error === null) expect(r.rows.map((x) => x.id)).toEqual(['open', 'null-received']);
  });

  test('drops a line whose parent status the CALLER does not accept', async () => {
    const { sb } = recordingSb([[
      line({ id: 'open', qty: 2, received_qty: 0 }),
      line({ id: 'closed', qty: 2, received_qty: 0, po: { id: 'po-9', po_number: 'PO-9', status: 'RECEIVED' } }),
    ]]);
    const r = await run(sb);
    expect(r.error).toBeNull();
    if (r.error === null) expect(r.rows.map((x) => x.id)).toEqual(['open']);
  });

  test('the ?poId scope is a SQL predicate on the LINE table', async () => {
    const { sb, calls } = recordingSb([[line()]]);
    await run(sb, { requestedPoIds: ['po-1', 'po-2'] });
    const f = used(calls, 'in').find((x) => x.args[1] === 'purchase_order_id');
    expect(f?.args[2]).toEqual(['po-1', 'po-2']);
  });

  test('carries the company predicate, and fails CLOSED when no company resolves', async () => {
    const scoped = recordingSb([[line()]]);
    await run(scoped.sb);
    expect(used(scoped.calls, 'eq').find((x) => x.args[1] === 'company_id')?.args[2]).toBe(1);

    const closed = recordingSb([[line()]]);
    await run(closed.sb, { ctx: { get: (k: string) => (k === 'allowedCompanyIds' ? [] : undefined) } });
    expect(used(closed.calls, 'in').find((x) => x.args[1] === 'company_id')?.args[2]).toEqual([]);
  });

  test('reports a read error instead of returning an empty list', async () => {
    const { sb } = recordingSb([[line()]], { error: { message: 'boom' } });
    const r = await run(sb);
    expect(r.error).toBe('boom');
  });

  test('a scoped PO that produced NO candidate rows triggers the HEADER read', async () => {
    const { sb, tables, calls } = recordingSb([[]]);
    await run(sb, { requestedPoIds: ['po-missing'] });
    expect(tables).toContain('purchase_orders');
    expect(used(calls, 'in').find((x) => x.args[0] === 'purchase_orders' && x.args[1] === 'id')?.args[2])
      .toEqual(['po-missing']);
  });
});
