// The remaining-quantity cap, and the state it used to be missing: "we could
// not find out".
//
// Before qty-cap.ts existed this guard lived ten times, in five route files, as
//
//     const { data: row } = await sb.from(...).maybeSingle();   // error dropped
//     if (row) { ...the entire cap... }
//
// so a failed read made `row` null, `if (row)` false, and the line was written
// with NO cap. The tests at the bottom are the ones that fail if anyone drops
// the error again.
import { describe, expect, test } from 'vitest';
import {
  capVerdict,
  qtyCapRefusal,
  QTY_CAP_CHECK_FAILED,
  QTY_EXCEEDS_REMAINING,
} from './qty-cap';

/* Minimal PostgREST stand-in: the guard only ever does
   .select(cols).eq('id', v).maybeSingle(). */
function fakeSb(rowsById: Record<string, Record<string, unknown>>) {
  return {
    from() {
      let wanted: string | null = null;
      const b: Record<string, unknown> = {
        select() { return b; },
        eq(_col: string, val: unknown) { wanted = String(val); return b; },
        maybeSingle() {
          return Promise.resolve({ data: wanted !== null ? (rowsById[wanted] ?? null) : null, error: null });
        },
      };
      return b;
    },
  } as never;
}

/** Every read fails, the way supabase-js actually fails: resolved, not thrown. */
function brokenSb(message = 'connection reset') {
  return {
    from() {
      const b: Record<string, unknown> = {
        select() { return b; },
        eq() { return b; },
        maybeSingle() { return Promise.resolve({ data: null, error: { message } }); },
      };
      return b;
    },
  } as never;
}

describe('capVerdict — the arithmetic, with no database in it', () => {
  test('a request inside the headroom passes', () => {
    expect(capVerdict({ requested: 3, cap: 10, drawn: 4 })).toBeNull();
  });

  test('an exact fit passes — the cap is a ceiling, not a margin', () => {
    expect(capVerdict({ requested: 6, cap: 10, drawn: 4 })).toBeNull();
  });

  test('one over refuses, and names the remaining the operator can act on', () => {
    expect(capVerdict({ requested: 7, cap: 10, drawn: 4 }))
      .toEqual({ error: QTY_EXCEEDS_REMAINING, requested: 7, remaining: 6 });
  });

  test('a fully drawn line refuses any further request', () => {
    expect(capVerdict({ requested: 1, cap: 10, drawn: 10 })?.remaining).toBe(0);
  });

  /* THE EDIT CASE. The stored rollup already counts this line, so its own prior
     draw is added back — otherwise re-saving a line at its existing qty would
     refuse itself. This is the one term that differs between the add sites and
     the edit sites; every one of the ten call sites is one of these two. */
  test('an edit is compared against what it would become, not against itself twice', () => {
    // Line already draws 4 of a 10 cap. Re-saving it at 4 must pass...
    expect(capVerdict({ requested: 4, cap: 10, drawn: 4, ownPriorDraw: 4 })).toBeNull();
    // ...raising it to 10 must pass (it is the only draw)...
    expect(capVerdict({ requested: 10, cap: 10, drawn: 4, ownPriorDraw: 4 })).toBeNull();
    // ...and 11 must not.
    expect(capVerdict({ requested: 11, cap: 10, drawn: 4, ownPriorDraw: 4 })?.remaining).toBe(10);
  });

  test('several drawn columns sum — the over-invoice cap nets returns too', () => {
    // purchase-invoices: accepted 10, invoiced 3, returned 2 -> remaining 5.
    expect(capVerdict({ requested: 5, cap: 10, drawn: 3 + 2 })).toBeNull();
    expect(capVerdict({ requested: 6, cap: 10, drawn: 3 + 2 })?.remaining).toBe(5);
  });
});

describe('qtyCapRefusal — reading the capping row', () => {
  const sb = fakeSb({ 'poi-1': { qty: 10, received_qty: 4 } });

  test('within cap: no refusal', async () => {
    expect(await qtyCapRefusal(sb, {
      table: 'purchase_order_items', id: 'poi-1',
      capColumn: 'qty', drawnColumns: ['received_qty'],
      requested: 6, what: 'PO line',
    })).toBeNull();
  });

  test('over cap: the existing 409 body, unchanged', async () => {
    expect(await qtyCapRefusal(sb, {
      table: 'purchase_order_items', id: 'poi-1',
      capColumn: 'qty', drawnColumns: ['received_qty'],
      requested: 7, what: 'PO line',
    })).toEqual({ error: 'qty_exceeds_remaining', requested: 7, remaining: 6 });
  });

  /* An unlinked / manual line has no capping row at all, and has always been
     uncapped. That behaviour is preserved on purpose — it is the ONLY absence
     this guard is allowed to treat as permission, and it is a real absence. */
  test('a genuinely missing capping row stays uncapped', async () => {
    expect(await qtyCapRefusal(sb, {
      table: 'purchase_order_items', id: 'no-such-line',
      capColumn: 'qty', drawnColumns: ['received_qty'],
      requested: 9999, what: 'PO line',
    })).toBeNull();
  });

  test('a non-numeric stored value counts as zero rather than poisoning the compare with NaN', async () => {
    // NaN loses every comparison silently, so `requested > NaN` would pass the cap.
    const junk = fakeSb({ 'poi-x': { qty: 'ten', received_qty: null } });
    expect(await qtyCapRefusal(junk, {
      table: 'purchase_order_items', id: 'poi-x',
      capColumn: 'qty', drawnColumns: ['received_qty'],
      requested: 1, what: 'PO line',
    })).toEqual({ error: QTY_EXCEEDS_REMAINING, requested: 1, remaining: 0 });
  });
});

/* ── THE REGRESSION THIS MODULE EXISTS FOR ─────────────────────────────────
   Make the read REJECT and assert the guard refuses rather than proceeds. If
   anyone drops the `error` binding in qtyCapRefusal again, `data` is null, the
   helper returns null, and every one of these fails — which is the point.

   A failed read must never read as an absence when the absence is what
   authorises the write. */
describe('a read that failed is not an absence', () => {
  test('an unreadable cap refuses, with its own code — not qty_exceeds_remaining', async () => {
    const refusal = await qtyCapRefusal(brokenSb(), {
      table: 'purchase_order_items', id: 'poi-1',
      capColumn: 'qty', drawnColumns: ['received_qty'],
      requested: 3, what: 'PO line',
    });
    expect(refusal).not.toBeNull();
    expect(refusal?.error).toBe(QTY_CAP_CHECK_FAILED);
  });

  test('it names the row it could not read and the reason, and offers the retry', async () => {
    const refusal = await qtyCapRefusal(brokenSb('statement timeout'), {
      table: 'grn_items', id: 'gi-1',
      capColumn: 'qty_accepted', drawnColumns: ['invoiced_qty', 'returned_qty'],
      requested: 3, what: 'GRN line',
    });
    expect(refusal).toMatchObject({ error: QTY_CAP_CHECK_FAILED, requested: 3 });
    const message = (refusal as { message: string }).message;
    expect(message).toContain('GRN line');
    expect(message).toContain('statement timeout');
    expect(message).toContain('try again');
  });

  /* A check that never ran has no remaining to report. Inventing `remaining: 0`
     would be the same lie in a quieter voice — and would tell the operator to
     reduce a quantity that was never the problem. */
  test('the check-failed refusal carries NO remaining number', async () => {
    const refusal = await qtyCapRefusal(brokenSb(), {
      table: 'grn_items', id: 'gi-1',
      capColumn: 'qty_accepted', drawnColumns: ['returned_qty'],
      requested: 3, what: 'GRN line',
    });
    expect(refusal).not.toHaveProperty('remaining');
  });

  test('an unreadable cap refuses even when the request is trivially small', async () => {
    // The old shape passed this: 1 unit onto a line whose cap it never read.
    expect((await qtyCapRefusal(brokenSb(), {
      table: 'purchase_consignment_order_items', id: 'pcoi-1',
      capColumn: 'qty', drawnColumns: ['received_qty'],
      requested: 1, what: 'PC Order line',
    }))?.error).toBe(QTY_CAP_CHECK_FAILED);
  });
});
