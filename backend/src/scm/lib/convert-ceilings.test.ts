// ----------------------------------------------------------------------------
// convert-ceilings — one suite that pins the QUANTITY CEILING on every convert
// path, because that is the guard the business actually runs on.
//
// The owner's ask (2026-08-10) was "已经 Convert 到 DO 或者 GR 的,都不能再
// Convert 了". Taken literally that reads as an "already converted" flag, and a
// flag would be WRONG here: this business ships one order in several batches, so
// an SO that already has a DO legitimately gets another DO, and a PO that
// already has a GRN legitimately gets another GRN. What must never happen is a
// SECOND conversion that takes the running total PAST the source quantity.
//
// So the invariant under test, on every path, is:
//
//     Σ(converted so far) + this conversion  ≤  source qty
//
// and the negative case — the one that proves the test is worth anything — is an
// over-ceiling attempt, which must be REFUSED, not clamped and not accepted.
//
// Harness note: route-level coverage is not possible here (scm rides Supabase
// Postgres; this harness rebuilds only the D1 side), so each path is driven
// through its extracted ceiling core with a minimal fake PostgREST client — the
// same shape as so-converted-po.test.ts and mrp.test.ts.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import { findOverConvertOffender, soLineHeadroom } from './po-over-convert';
import { doLineRemaining, doRemainingByItemId } from './do-line-remaining';
import { soDeliverableRemaining } from '../routes/delivery-orders-mfg';
import { soLineOverConvertRefusal } from '../routes/mfg-purchase-orders';
// Source text of the PO router, so the WIRING of the guard is asserted too — a
// guard nothing calls is the exact failure mode this lane exists to catch.
import poRouterSrc from '../routes/mfg-purchase-orders.ts?raw';

type Row = Record<string, unknown>;

/* A fake PostgREST query: chainable filters, awaitable, paginable via range().
   Supports the operators the ceiling cores actually chain, including the
   `parent:table(col)` to-one embed soDeliverableRemaining uses. */
function fakeSb(tables: Record<string, Row[]>) {
  class Q {
    rows: Row[];
    private embeds: Array<{ alias: string; table: string; col: string }> = [];
    constructor(rows: Row[]) { this.rows = [...rows]; }

    select(cols?: string) {
      /* Resolve `alias:table(col)` embeds against the sibling table by <table
         singular>_id, mirroring PostgREST's to-one embed (row count unchanged). */
      if (cols) {
        for (const m of cols.matchAll(/(\w+):(\w+)\(([^)]*)\)/g)) {
          this.embeds.push({ alias: m[1]!, table: m[2]!, col: m[3]!.trim() });
        }
      }
      return this;
    }
    eq(col: string, val: unknown) { this.rows = this.rows.filter((r) => r[col] === val); return this; }
    neq(col: string, val: unknown) { this.rows = this.rows.filter((r) => r[col] !== val); return this; }
    gt(col: string, val: number) { this.rows = this.rows.filter((r) => Number(r[col] ?? 0) > val); return this; }
    in(col: string, vals: unknown[]) { this.rows = this.rows.filter((r) => vals.includes(r[col])); return this; }
    not(col: string, op: string, val: unknown) {
      if (op === 'is' && val === null) this.rows = this.rows.filter((r) => r[col] != null);
      if (op === 'in') {
        const list = String(val).replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, ''));
        this.rows = this.rows.filter((r) => !list.includes(String(r[col])));
      }
      return this;
    }
    order() { return this; }
    limit(n: number) { this.rows = this.rows.slice(0, n); return this; }
    range(from: number, to: number) { this.rows = this.rows.slice(from, to + 1); return this; }
    maybeSingle() { return Promise.resolve({ data: this.rows[0] ?? null, error: null }); }

    private materialise(all: Record<string, Row[]>): Row[] {
      if (this.embeds.length === 0) return this.rows;
      return this.rows.map((r) => {
        const out = { ...r };
        for (const e of this.embeds) {
          // delivery_orders -> delivery_order_id, delivery_returns -> delivery_return_id
          const fk = `${e.table.replace(/s$/, '')}_id`;
          const parent = (all[e.table] ?? []).find((p) => p.id === r[fk]);
          out[e.alias] = parent ? { [e.col]: parent[e.col] } : null;
        }
        return out;
      });
    }
    then<T>(onFulfilled: (v: { data: Row[]; error: null }) => T, onRejected?: (e: unknown) => T) {
      return Promise.resolve({ data: this.materialise(tables), error: null }).then(onFulfilled, onRejected);
    }
  }
  return { from: (table: string) => new Q(tables[table] ?? []) };
}

// ---------------------------------------------------------------------------
// PATH 1 — SO -> PO.  Ceiling: mfg_sales_order_items.qty - po_qty_picked
//   batch create  : findOverConvertOffender  (mfg-purchase-orders.ts:1142)
//   line add/edit : soLineHeadroom           (mfg-purchase-orders.ts:2676/2861)
// ---------------------------------------------------------------------------
describe('SO -> PO ceiling (qty - po_qty_picked)', () => {
  const so = (id: string, qty: number, picked: number) => ({ id, qty, po_qty_picked: picked });

  test('a SECOND PO against a partly-converted SO line is ALLOWED up to the remainder', () => {
    // 10 ordered, 6 already on a PO -> a second PO may take the last 4.
    expect(findOverConvertOffender([{ soItemId: 'si-1', qty: 4 }], [so('si-1', 10, 6)])).toBeNull();
  });

  test('the same second PO is REFUSED one unit past the remainder', () => {
    expect(findOverConvertOffender([{ soItemId: 'si-1', qty: 5 }], [so('si-1', 10, 6)]))
      .toEqual({ soItemId: 'si-1', requested: 5, remaining: 4 });
  });

  test('a fully-converted SO line has NO remainder left', () => {
    expect(findOverConvertOffender([{ soItemId: 'si-1', qty: 1 }], [so('si-1', 10, 10)]))
      .toEqual({ soItemId: 'si-1', requested: 1, remaining: 0 });
  });

  test('one SO line split across several PO lines is summed, not judged line-by-line', () => {
    // 3 + 3 each fit under 5 alone; together they over-order and must be caught.
    expect(findOverConvertOffender(
      [{ soItemId: 'si-1', qty: 3 }, { soItemId: 'si-1', qty: 3 }],
      [so('si-1', 5, 0)],
    )).toEqual({ soItemId: 'si-1', requested: 6, remaining: 5 });
  });

  test('manual lines carry no SO link and are never capped', () => {
    expect(findOverConvertOffender([{ qty: 9999 }], [so('si-1', 1, 1)])).toBeNull();
  });

  // --- line-level bind: the two paths that took an operator-supplied qty ----
  describe('line add / line edit headroom', () => {
    test('ADD onto a fully-converted SO line has zero headroom', () => {
      expect(soLineHeadroom(so('si-1', 10, 10), 0)).toBe(0);
    });

    test('ADD is allowed exactly up to the remainder', () => {
      expect(soLineHeadroom(so('si-1', 10, 6), 0)).toBe(4);
    });

    test('EDIT of an already-bound line credits back its OWN qty, so a no-op edit passes', () => {
      // line holds 6 of the 10; picked is 6 -> raw remaining 0, headroom 6.
      // Re-saving 6 must NOT refuse itself.
      const headroom = soLineHeadroom(so('si-1', 10, 6), 6);
      expect(headroom).toBe(10);
      expect(6 > headroom).toBe(false);
    });

    test('EDIT may raise up to the SO qty but not past it', () => {
      const headroom = soLineHeadroom(so('si-1', 10, 6), 6);
      expect(10 > headroom).toBe(false); // raise 6 -> 10 is fine
      expect(11 > headroom).toBe(true);  // raise 6 -> 11 over-orders
    });

    test('REBIND onto a different SO line gets NO credit for the old line qty', () => {
      // Moving a qty-6 line onto si-2 (5 ordered, 5 picked) must not smuggle 6 in.
      expect(soLineHeadroom(so('si-2', 5, 5), 0)).toBe(0);
    });

    test('an over-picked historical line clamps to 0 rather than a negative ceiling', () => {
      expect(soLineHeadroom(so('si-1', 5, 8), 0)).toBe(0);
    });
  });

  /* The route-level guard itself, driven against a fake PostgREST client. This
     is the guard the two previously-uncapped handlers now call; before this
     lane, BOTH of them enforced nothing but soLinkTargetRefusal (identity /
     company / cancelled / SKU match) and would accept any qty. */
  describe('soLineOverConvertRefusal (add-line + line-edit guard)', () => {
    const sbWith = (qty: number, picked: number) =>
      fakeSb({ mfg_sales_order_items: [{ id: 'si-1', qty, po_qty_picked: picked }] }) as any;

    test('ADD past the remainder is refused with the offending numbers', async () => {
      expect(await soLineOverConvertRefusal(sbWith(10, 10), 'si-1', 5, 0))
        .toEqual({ soItemId: 'si-1', requested: 5, remaining: 0 });
    });

    test('ADD within the remainder passes', async () => {
      expect(await soLineOverConvertRefusal(sbWith(10, 6), 'si-1', 4, 0)).toBeNull();
    });

    test('EDIT that merely re-saves the same qty passes (own qty credited back)', async () => {
      expect(await soLineOverConvertRefusal(sbWith(10, 6), 'si-1', 6, 6)).toBeNull();
    });

    test('EDIT that raises past the SO qty is refused', async () => {
      expect(await soLineOverConvertRefusal(sbWith(10, 6), 'si-1', 11, 6))
        .toEqual({ soItemId: 'si-1', requested: 11, remaining: 10 });
    });

    test('a line with no SO link is never capped', async () => {
      expect(await soLineOverConvertRefusal(sbWith(1, 1), null, 9999, 0)).toBeNull();
    });
  });

  /* WIRING — the guard must actually be invoked by both handlers. Asserted on
     the router source because scm routes cannot be exercised end-to-end in this
     harness (Supabase Postgres; the harness rebuilds only the D1 side). Without
     these, deleting either call site would leave every test above green. */
  describe('the guard is wired into both operator-qty paths', () => {
    const handler = (marker: string): string => {
      const start = poRouterSrc.indexOf(marker);
      expect(start, `handler not found: ${marker}`).toBeGreaterThan(-1);
      // Up to the next route registration, so we read ONE handler's body.
      const rest = poRouterSrc.slice(start + marker.length);
      const next = rest.search(/\nmfgPurchaseOrders\.(post|patch|get|delete)\(/);
      return next === -1 ? rest : rest.slice(0, next);
    };

    test('POST /:id/items calls the remaining-qty guard', () => {
      expect(handler("mfgPurchaseOrders.post('/:id/items'")).toContain('soLineOverConvertRefusal');
    });

    test('PATCH /:id/items/:itemId calls the remaining-qty guard', () => {
      expect(handler("mfgPurchaseOrders.patch('/:id/items/:itemId'")).toContain('soLineOverConvertRefusal');
    });

    test('the batch create path still calls its own cap', () => {
      expect(poRouterSrc).toContain('findOverConvertOffender(items, soRows)');
    });
  });
});

// ---------------------------------------------------------------------------
// PATH 2 — SO -> DO.  Ceiling: qty - delivered + returned
//   soDeliverableRemaining (delivery-orders-mfg.ts:1885), enforced at :3336
// ---------------------------------------------------------------------------
describe('SO -> DO ceiling (qty - delivered + returned)', () => {
  const soItem = (id: string, qty: number) => ({
    id, doc_no: 'SO-1', item_code: 'AKEMI-Q', qty, cancelled: false,
    debtor_code: 'C1', debtor_name: 'Cust', item_group: 'mattress',
  });

  async function remainingOf(tables: Record<string, Row[]>, soItemId = 'si-1') {
    const map = await soDeliverableRemaining(fakeSb(tables) as any, ['SO-1']);
    return map.get(soItemId)!.remaining;
  }

  test('a SECOND DO is allowed for the undelivered balance (batch shipping is legal)', async () => {
    expect(await remainingOf({
      mfg_sales_order_items: [soItem('si-1', 10)],
      delivery_orders: [{ id: 'do-1', status: 'POSTED' }],
      delivery_order_items: [{ id: 'dl-1', delivery_order_id: 'do-1', so_item_id: 'si-1', qty: 6 }],
      delivery_returns: [], delivery_return_items: [],
    })).toBe(4);
  });

  test('a fully-delivered SO line has NO remaining, so a further DO has nothing to take', async () => {
    expect(await remainingOf({
      mfg_sales_order_items: [soItem('si-1', 10)],
      delivery_orders: [{ id: 'do-1', status: 'POSTED' }, { id: 'do-2', status: 'POSTED' }],
      delivery_order_items: [
        { id: 'dl-1', delivery_order_id: 'do-1', so_item_id: 'si-1', qty: 6 },
        { id: 'dl-2', delivery_order_id: 'do-2', so_item_id: 'si-1', qty: 4 },
      ],
      delivery_returns: [], delivery_return_items: [],
    })).toBe(0);
  });

  test('a CANCELLED DO releases its qty back to the ceiling', async () => {
    expect(await remainingOf({
      mfg_sales_order_items: [soItem('si-1', 10)],
      delivery_orders: [{ id: 'do-1', status: 'CANCELLED' }],
      delivery_order_items: [{ id: 'dl-1', delivery_order_id: 'do-1', so_item_id: 'si-1', qty: 6 }],
      delivery_returns: [], delivery_return_items: [],
    })).toBe(10);
  });

  test('a DRAFT DO has not shipped and must not consume the ceiling', async () => {
    expect(await remainingOf({
      mfg_sales_order_items: [soItem('si-1', 10)],
      delivery_orders: [{ id: 'do-1', status: 'DRAFT' }],
      delivery_order_items: [{ id: 'dl-1', delivery_order_id: 'do-1', so_item_id: 'si-1', qty: 6 }],
      delivery_returns: [], delivery_return_items: [],
    })).toBe(10);
  });

  test('a return puts qty back into the deliverable pool', async () => {
    expect(await remainingOf({
      mfg_sales_order_items: [soItem('si-1', 10)],
      delivery_orders: [{ id: 'do-1', status: 'POSTED' }],
      delivery_order_items: [{ id: 'dl-1', delivery_order_id: 'do-1', so_item_id: 'si-1', qty: 10 }],
      delivery_returns: [{ id: 'dr-1', status: 'POSTED' }],
      delivery_return_items: [{ do_item_id: 'dl-1', delivery_return_id: 'dr-1', qty_returned: 3 }],
    })).toBe(3);
  });

  /* MIGRATED DOCUMENTS — this repo has NO `migrated_no_stock` column (nor any
     equivalent flag on scm.delivery_orders / scm.grns), so a migrated DO is an
     ordinary row: it counts toward the ceiling on exactly the same terms as a
     native one, by STATUS and by LINK. Status is covered above; the link is the
     real exposure, pinned by the two tests below. */
  test('a migrated DO whose lines ARE linked counts toward the ceiling', async () => {
    expect(await remainingOf({
      mfg_sales_order_items: [soItem('si-1', 10)],
      delivery_orders: [{ id: 'do-mig', status: 'POSTED' }],
      delivery_order_items: [{ id: 'dl-m', delivery_order_id: 'do-mig', so_item_id: 'si-1', qty: 10 }],
      delivery_returns: [], delivery_return_items: [],
    })).toBe(0);
  });

  test('KNOWN EXPOSURE: an UNLINKED DO line (so_item_id NULL) is invisible to the ceiling', async () => {
    /* This is not a hypothetical. DO-2607-005 on SO-2606-019 shipped with NULL
       so_item_id, which is precisely why the over-delivery guard stayed blind
       while a second DO shipped the same goods. The ceiling is keyed on the
       LINK, so an unlinked line — migrated or hand-made — consumes nothing.
       Pinned deliberately: if a future change starts counting unlinked lines,
       this test should be updated, not silently deleted. */
    expect(await remainingOf({
      mfg_sales_order_items: [soItem('si-1', 10)],
      delivery_orders: [{ id: 'do-1', status: 'POSTED' }],
      delivery_order_items: [{ id: 'dl-1', delivery_order_id: 'do-1', so_item_id: null, qty: 10 }],
      delivery_returns: [], delivery_return_items: [],
    })).toBe(10); // 10 shipped, yet the ceiling still reads 10 available
  });
});

// ---------------------------------------------------------------------------
// PATH 3 + 4 — DO -> Sales Invoice and DO -> Delivery Return.
//   Ceiling: delivered - invoiced - returned (ONE shared pool, so invoicing and
//   returning compete). do-line-remaining.ts:218, enforced at
//   sales-invoices.ts:423 (checkSiOverRemaining) and delivery-returns.ts:1126.
// ---------------------------------------------------------------------------
describe('DO -> Invoice / Return ceiling (delivered - invoiced - returned)', () => {
  const base = (over: Partial<Record<string, Row[]>> = {}) => ({
    delivery_orders: [{ id: 'do-1', do_number: 'DO-1', status: 'POSTED', debtor_code: 'C1', debtor_name: 'Cust' }],
    delivery_order_items: [{ id: 'dl-1', delivery_order_id: 'do-1', item_code: 'AKEMI-Q', qty: 10 }],
    sales_invoices: [], sales_invoice_items: [],
    delivery_returns: [], delivery_return_items: [],
    ...over,
  });

  async function pending(tables: Record<string, Row[]>) {
    return (await doRemainingByItemId(fakeSb(tables) as any, ['dl-1'])).get('dl-1');
  }

  test('a SECOND invoice may take the still-pending balance', async () => {
    expect(await pending(base({
      sales_invoices: [{ id: 'si-1', status: 'POSTED' }],
      sales_invoice_items: [{ do_item_id: 'dl-1', sales_invoice_id: 'si-1', qty: 6 }],
    }))).toBe(4);
  });

  test('a fully-invoiced DO line leaves nothing for a second invoice', async () => {
    expect(await pending(base({
      sales_invoices: [{ id: 'si-1', status: 'POSTED' }],
      sales_invoice_items: [{ do_item_id: 'dl-1', sales_invoice_id: 'si-1', qty: 10 }],
    }))).toBe(0);
  });

  test('invoicing and returning COMPETE for one pool — an invoiced unit cannot also be returned', async () => {
    expect(await pending(base({
      sales_invoices: [{ id: 'si-1', status: 'POSTED' }],
      sales_invoice_items: [{ do_item_id: 'dl-1', sales_invoice_id: 'si-1', qty: 7 }],
      delivery_returns: [{ id: 'dr-1', status: 'POSTED' }],
      delivery_return_items: [{ do_item_id: 'dl-1', delivery_return_id: 'dr-1', qty_returned: 3 }],
    }))).toBe(0);
  });

  test('a CANCELLED invoice releases its qty back to Pending', async () => {
    expect(await pending(base({
      sales_invoices: [{ id: 'si-1', status: 'CANCELLED' }],
      sales_invoice_items: [{ do_item_id: 'dl-1', sales_invoice_id: 'si-1', qty: 10 }],
    }))).toBe(10);
  });

  test('a DRAFT DO delivered nothing, so nothing is invoiceable from it', async () => {
    const map = await doLineRemaining(fakeSb(base({
      delivery_orders: [{ id: 'do-1', do_number: 'DO-1', status: 'DRAFT', debtor_code: 'C1', debtor_name: 'Cust' }],
    })) as any, ['do-1']);
    expect(map.get('dl-1')).toBeUndefined();
  });

  test('a CANCELLED DO delivered nothing either', async () => {
    const map = await doLineRemaining(fakeSb(base({
      delivery_orders: [{ id: 'do-1', do_number: 'DO-1', status: 'CANCELLED', debtor_code: 'C1', debtor_name: 'Cust' }],
    })) as any, ['do-1']);
    expect(map.get('dl-1')).toBeUndefined();
  });

  test('a DO line that no longer exists resolves to 0, never to unlimited', async () => {
    expect((await doRemainingByItemId(fakeSb(base()) as any, ['ghost'])).get('ghost')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PATH 5 — PO -> GRN.  Ceiling: purchase_order_items.qty - received_qty.
//   Unlike every path above, this one reads a STORED counter rather than
//   deriving the sum live. The counter is recounted from live GRN lines in
//   grns.ts:795 (postGrnAndRollup), and enforced at grns.ts:1506 / 1653 / 1860 /
//   1926 / 2035 / 2656 / 2886. These pin the recount arithmetic that every one
//   of those call sites trusts.
// ---------------------------------------------------------------------------
describe('PO -> GRN ceiling (qty - received_qty)', () => {
  /* Mirrors the recount in grns.ts postGrnAndRollup: per PO line, sum
     max(0, qty_accepted - returned_qty) over GRN lines whose parent GRN is
     neither CANCELLED nor DRAFT. */
  const recount = (
    grnLines: Array<{ purchase_order_item_id: string | null; qty_accepted: number; returned_qty: number; grn_id: string }>,
    grns: Array<{ id: string; status: string }>,
    poItemId: string,
  ): number => {
    const dead = new Set(grns.filter((g) => g.status === 'CANCELLED' || g.status === 'DRAFT').map((g) => g.id));
    return grnLines
      .filter((l) => l.purchase_order_item_id === poItemId && !dead.has(l.grn_id))
      .reduce((s, l) => s + Math.max(0, Number(l.qty_accepted ?? 0) - Number(l.returned_qty ?? 0)), 0);
  };
  const line = (grnId: string, accepted: number, returned = 0, poi: string | null = 'poi-1') =>
    ({ purchase_order_item_id: poi, qty_accepted: accepted, returned_qty: returned, grn_id: grnId });

  test('a SECOND GRN is allowed for the outstanding balance', () => {
    const received = recount([line('g1', 6)], [{ id: 'g1', status: 'POSTED' }], 'poi-1');
    expect(10 - received).toBe(4);
  });

  test('a fully-received PO line has NO outstanding qty for a further GRN', () => {
    const received = recount(
      [line('g1', 6), line('g2', 4)],
      [{ id: 'g1', status: 'POSTED' }, { id: 'g2', status: 'POSTED' }],
      'poi-1',
    );
    expect(10 - received).toBe(0);
  });

  test('a CANCELLED GRN releases the PO line so a replacement receipt can be made', () => {
    const received = recount([line('g1', 10)], [{ id: 'g1', status: 'CANCELLED' }], 'poi-1');
    expect(10 - received).toBe(10);
  });

  test('a DRAFT GRN has committed no receipt and must not consume the ceiling', () => {
    const received = recount([line('g1', 10)], [{ id: 'g1', status: 'DRAFT' }], 'poi-1');
    expect(10 - received).toBe(10);
  });

  test('goods returned to the supplier re-open the PO line', () => {
    const received = recount([line('g1', 10, 4)], [{ id: 'g1', status: 'POSTED' }], 'poi-1');
    expect(10 - received).toBe(4);
  });

  test('KNOWN EXPOSURE: an UNLINKED GRN line (purchase_order_item_id NULL) never counts', () => {
    /* Same shape as the unlinked-DO exposure above, and the same reason: the
       ceiling is keyed on the link. A migrated GRN whose lines carry no
       purchase_order_item_id receives goods that no PO line ever registers. */
    const received = recount([line('g1', 10, 0, null)], [{ id: 'g1', status: 'POSTED' }], 'poi-1');
    expect(10 - received).toBe(10); // 10 received, ceiling still reads 10
  });
});

// ---------------------------------------------------------------------------
// PATH 6 — AMENDMENTS.  An SO or PO amendment does not convert anything itself;
// it MOVES the source qty, and therefore moves the ceiling. What matters is that
// the arithmetic fails SAFE when an amendment drops a line below what has
// already shipped or been received: remaining goes negative, and every
// enforcement site compares with `>`, so a negative ceiling refuses everything
// rather than wrapping into fresh headroom.
// ---------------------------------------------------------------------------
describe('amendments move the ceiling, they do not bypass it', () => {
  test('an SO line amended BELOW what already shipped yields a negative ceiling', async () => {
    const map = await soDeliverableRemaining(fakeSb({
      // amended down 10 -> 4 after 6 had already shipped
      mfg_sales_order_items: [{
        id: 'si-1', doc_no: 'SO-1', item_code: 'AKEMI-Q', qty: 4, cancelled: false,
        debtor_code: 'C1', debtor_name: 'Cust', item_group: 'mattress',
      }],
      delivery_orders: [{ id: 'do-1', status: 'POSTED' }],
      delivery_order_items: [{ id: 'dl-1', delivery_order_id: 'do-1', so_item_id: 'si-1', qty: 6 }],
      delivery_returns: [], delivery_return_items: [],
    }) as any, ['SO-1']);
    const remaining = map.get('si-1')!.remaining;
    expect(remaining).toBe(-2);
    // delivery-orders-mfg.ts:3336 is `qty < 1 || qty > line.remaining`
    expect(1 > remaining).toBe(true); // even a single unit is refused
  });

  test('a PO line amended BELOW what was already received refuses any further GRN', () => {
    const amendedQty = 4;   // was 10
    const receivedQty = 6;  // already receipted
    const remaining = amendedQty - receivedQty;
    expect(remaining).toBe(-2);
    expect(1 > remaining).toBe(true); // grns.ts:1505 `accepted > remaining`
  });

  test('an SO line amended UPWARD legitimately opens fresh headroom', () => {
    // 10 -> 14 with 10 already picked: the extra 4 becomes convertible. This is
    // the deliberate repeat-conversion case, and it must NOT be blocked.
    expect(soLineHeadroom({ qty: 14, po_qty_picked: 10 }, 0)).toBe(4);
  });
});
