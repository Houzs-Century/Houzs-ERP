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
  explainOutstanding, remainingOf, OUTSTANDING_PAGE, OUTSTANDING_MAX_PAGES,
  type CountableRow,
} from './outstanding-po-lines';
// Source text of the GRN router, so the WIRING is asserted too — the old code
// read fine and was wrong about which rows it had.
import grnRouterSrc from '../routes/grns.ts?raw';

const row = (poId: string, qty: number, received: number, status = 'SUBMITTED'): CountableRow => ({
  purchase_order_id: poId, qty, received_qty: received,
  po: { po_number: `PO-${poId}`, status },
});

/* The predicate the ROUTE owns. Passed in on purpose: this module must not hold
   a second copy of the receivable set (see the module header). */
const isReceivable = (s: string | null | undefined): boolean =>
  s === 'SUBMITTED' || s === 'PARTIALLY_RECEIVED';

describe('MECHANISM 1 — the read is paged, and says so when it stops early', () => {
  /* A fake page source: hands out `total` rows in windows, counting the calls. */
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
    // The exact regression. 1,400 candidate lines used to arrive as 500.
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
    // THE POINT. `paginateAll` cannot express this, which is why it is not used.
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
    // Narrower than the complement of RECEIVABLE on purpose — the module header
    // gives the reason (an `.in()` on an embedded path is an unproven form).
    expect([...PO_DEAD_FOR_RECEIPT]).toEqual(['DRAFT', 'CANCELLED']);
  });

  test('the quoted in-list matches mrp.ts sqlNotInList byte for byte', () => {
    expect(poDeadForReceiptSql()).toBe('("DRAFT","CANCELLED")');
  });

  test('the route uses .not(…in…) on the EMBEDDED alias, not a bare column', () => {
    expect(grnRouterSrc).toContain(".not('po.status', 'in', poDeadForReceiptSql())");
  });

  test('the JS gate is still the authority on the exact receivable set', () => {
    expect(grnRouterSrc).toContain('.filter((r) => isReceivablePoStatus(r.po.status))');
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

  test('the route applies the scope as a SQL predicate on the line table', () => {
    expect(grnRouterSrc).toContain("q = q.in('purchase_order_id', requestedPoIds)");
  });

  test('the route reads the parameter at all — it used to be browser-only', () => {
    expect(grnRouterSrc).toContain("parsePoIdScope(c.req.query('poId'))");
  });

  test('the window is ordered by the LINE key, not by the parent id', () => {
    // `purchase_order_id DESC` was a key order masquerading as "newest first",
    // and it is not a total order, so pages could overlap or skip.
    expect(grnRouterSrc).not.toContain("order('purchase_order_id', { ascending: false })");
    expect(grnRouterSrc).toContain("q.order('id').range(from, to)");
  });

  test('the old silent cap is gone from this handler', () => {
    const start = grnRouterSrc.indexOf("grns.get('/outstanding-po-items'");
    // `grnLineDownstream` is CALLED earlier in the file than it is declared, so
    // slice forward from the handler rather than to the first mention of it — a
    // backwards window would be empty and this whole assertion would vacuously
    // pass, which is the "verdict computed over nothing" trap in CLAUDE.md. The
    // length check below is the tripwire for that.
    const end = grnRouterSrc.indexOf('export async function grnLineDownstream', start);
    const handler = grnRouterSrc.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(handler.length).toBeGreaterThan(500);
    /* Strip comments before asserting. The handler DESCRIBES the cap it removed,
       and a raw substring match on the prose would fail while the code is right
       — which teaches the next person to delete the provenance to get green. */
    const code = handler.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\.limit\(/);
    expect(code).toContain('pageWithTruncation');
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
      poId: 'p1', poDocNo: 'PO-p1', status: 'PARTIALLY_RECEIVED',
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

  test('a DRAFT PO produces no candidate rows, so its status comes from the HEADER read', () => {
    // The SQL filter drops it, so without the header read "your PO is a draft"
    // is indistinguishable from "your PO does not exist" — and both used to
    // render as "every line has been received".
    const s = explainOutstanding(
      ['p1'], [], new Map([['p1', { poDocNo: 'PO-9', status: 'DRAFT' }]]), false, isReceivable,
    );
    expect(s.pos).toEqual([{
      poId: 'p1', poDocNo: 'PO-9', status: 'DRAFT',
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
    // A caller whose rule is "SUBMITTED only" must get SUBMITTED only. If this
    // module ever grows its own list, this test fails.
    const submittedOnly = (s: string | null | undefined) => s === 'SUBMITTED';
    const r = explainOutstanding(
      ['p1'], [row('p1', 5, 0, 'PARTIALLY_RECEIVED')], new Map(), false, submittedOnly,
    );
    expect(r.pos[0]!.receivable).toBe(false);
  });

  test('the route hands its OWN predicate in, so picker and converter cannot drift', () => {
    expect(grnRouterSrc).toContain('requestedPoIds, candidates, headerStatuses, truncated, isReceivablePoStatus');
  });

  test('the route actually returns the scope — a report nobody sends explains nothing', () => {
    expect(grnRouterSrc).toContain('c.json({ items: outstanding, scope })');
  });
});
