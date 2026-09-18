/* ----------------------------------------------------------------------------
   shipped-progress — HOW MUCH HAS LEFT, as its own answer.

   Owner, 2026-09-02, on partial delivery: 「partialy delivery 该怎么办呢 / 看一下
   那个 column 进入适合」, and he chose splitting the two facts apart.

   THE PROBLEM. "Stock Status" answers ARRIVAL — has the supplier's goods come in
   (PENDING / PARTIAL / READY, from so-readiness-row.ts). Shipping was visible
   only at its two ENDS: a line reads DELIVERED once everything has left, and
   nothing before that. So an order with 5 arrived and 2 shipped read plain
   READY, and "we still owe this customer 3" was on no screen.

   Two questions, two columns. This module owns the second one and nothing else.

   IT IS DELIBERATELY NOT NAMED delivery_*. `delivery_state` is already TWO
   different things here — the stored scheduling override on mfg_sales_orders
   (PENDING_SCHEDULE, see tripReconcile.ts / arrangement-stage.ts) and the
   computed none/partial/full shipping verdict that shadows it on the response.
   There are likewise two exported types called `DeliveryState`. A third meaning
   under that prefix is how the next reader picks the wrong one.
   -------------------------------------------------------------------------- */

export type ShippedProgress = {
  /** How many units have left. */
  shipped: number;
  /** How many the order is committed to deliver — shipped + still owed, net of
   *  cancellation, taken from the same deliverable engine the picker uses. */
  deliverable: number;
  /** 'none' before the first delivery, 'partial' while any is owed, 'full' when
   *  none is. `unknown` when the payload predates these fields — NOT 'none',
   *  which would claim nothing has shipped. */
  state: 'none' | 'partial' | 'full' | 'unknown';
};

export type ShippedProgressFields = {
  shipped_qty?: number | null;
  deliverable_qty?: number | null;
};

/** Resolve a row / line into the progress, or `unknown` when it cannot say.
 *  Missing is NOT zero: an older payload carries neither field, and reading
 *  that as "0 shipped" is the same class of lie as rendering STOCK while a
 *  query is still loading (docs/modules/coverage-state.md). */
export function shippedProgressOf(r: ShippedProgressFields): ShippedProgress {
  const shipped = r.shipped_qty;
  const deliverable = r.deliverable_qty;
  if (typeof shipped !== 'number' || typeof deliverable !== 'number') {
    return { shipped: 0, deliverable: 0, state: 'unknown' };
  }
  /* A deliverable of 0 means there is nothing to ship (every line cancelled, or
     a service-only order). That is 'none', never 'full' — calling it fully
     delivered would put a DELIVERED badge on an order nobody ever shipped. */
  if (deliverable <= 0) return { shipped, deliverable, state: 'none' };
  if (shipped <= 0) return { shipped, deliverable, state: 'none' };
  return { shipped, deliverable, state: shipped >= deliverable ? 'full' : 'partial' };
}

/** The cell's text. `null` when unknown, so the caller renders its own
 *  placeholder rather than this module inventing one. */
export function shippedProgressLabel(p: ShippedProgress): string | null {
  if (p.state === 'unknown') return null;
  if (p.deliverable <= 0) return '—';
  return `${p.shipped} / ${p.deliverable}`;
}

/* A LINE carries the same two facts under the names the SO detail has always
   used. Adapting here rather than at the call site is the point: one rule, so
   the row and the line can never disagree about the same order. */
export type ShippedProgressLineFields = {
  delivered_qty?: number | null;
  remaining_qty?: number | null;
};

export function shippedProgressOfLine(l: ShippedProgressLineFields): ShippedProgress {
  const delivered = l.delivered_qty;
  const remaining = l.remaining_qty;
  if (typeof delivered !== 'number' || typeof remaining !== 'number') {
    return { shipped: 0, deliverable: 0, state: 'unknown' };
  }
  return shippedProgressOf({ shipped_qty: delivered, deliverable_qty: delivered + remaining });
}
