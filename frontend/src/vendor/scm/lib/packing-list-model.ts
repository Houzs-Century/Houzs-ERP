/* ----------------------------------------------------------------------------
   packing-list-model — the two rules a packing list is FOR, in one place so the
   screen and the printed sheet can never disagree about them.

   1. THE SHEET IS THE REVERSE OF THE ROUTE. Stops are numbered 1..N in DELIVERY
      order (`trip_stops.stop_no`, as the dispatcher sequenced them). Loading
      runs the other way — owner, 2026-08-25: 「我们进货 Loading 的时候，都是把最
      后一张单放在最里面，所以顺序应该反过来」. The LAST delivery goes in FIRST,
      deepest into the lorry, so the first drop is the one standing at the tail
      door. `loadingOrder` is the only place that reversal happens.

      IT IS NUMBERED BY LOADING ORDER ONLY. The sheet prints 1, 2, 3 — the order
      you put things in — and does NOT also print the stop number beside it. The
      owner looked at the two-number form and rejected it:「LOAD FIRST ① STOP 3
      · … 这个地方太复杂了」. One number per line.

   2. THE STATUS CHIP ROLLS UP THE MEMBER DELIVERY ORDERS. The words are the
      owner's ladder — Confirmed / Loaded / In Transit / Delivered — over the
      four rungs `scm.do_status` actually has. `rollupDeliveryStatus` names the
      furthest rung ANY member DO has reached and counts how many have reached
      it: "Loaded 2/3".

      AND IT REFUSES TO ANSWER OVER NOTHING. A trip with no readable delivery
      order returns null, and the caller renders a dash. Every enum literal it
      compares is a member of `scm.do_status` — a string that is not is a
      `22P02` in Postgres and took the whole Delivery Orders page down twice
      (docs/bugs/0530), and here it would silently bucket a row nowhere.
   ---------------------------------------------------------------------------- */

import type { PackingStop } from './packing-list-queries';

/* ── 1. Loading order ─────────────────────────────────────────────────────── */

export type LoadingSection<S> = {
  /** 1..N in LOADING order. NOT the stop number — see the note above. */
  load_no: number;
  stop: S;
};

/**
 * Delivery order in, LOADING order out. Pure, total, and non-mutating: the
 * caller's array is left alone, because the screen renders the delivery order
 * from the same rows the sheet reverses.
 */
export function loadingOrder<S extends { stop_no: number }>(stops: readonly S[]): LoadingSection<S>[] {
  const byDelivery = [...stops].sort((a, b) => a.stop_no - b.stop_no);
  const out: LoadingSection<S>[] = [];
  for (let i = byDelivery.length - 1; i >= 0; i -= 1) {
    out.push({ load_no: out.length + 1, stop: byDelivery[i] });
  }
  return out;
}

/* ── 2. The delivery-status rollup ────────────────────────────────────────── */

/** The owner's four rungs, in his words, over the statuses scm.do_status has.
 *  DRAFT is deliberately rung 0 — it is before the ladder starts, not on it. */
/* A Map, not an object literal: `.get()` returns `| undefined`, so the miss
   branch below is a real branch the compiler and the linter both see. An index
   into a `Record<string, T>` types as T, which makes the guard read as dead
   code — and deleting it is how an unlisted status would silently become
   rung 0. */
export const DO_RUNG: ReadonlyMap<string, { rung: number; label: string }> = new Map([
  ['DRAFT', { rung: 0, label: 'Draft' }],
  ['LOADED', { rung: 1, label: 'Confirmed' }],
  ['DISPATCHED', { rung: 2, label: 'Loaded' }],
  ['IN_TRANSIT', { rung: 3, label: 'In Transit' }],
  ['SIGNED', { rung: 4, label: 'Delivered' }],
  ['DELIVERED', { rung: 4, label: 'Delivered' }],
  ['INVOICED', { rung: 4, label: 'Delivered' }],
]);

export type StatusRollup = {
  /** The furthest rung any member delivery order has reached. */
  label: string;
  /** How many have reached that rung. */
  reached: number;
  /** How many delivery orders the count is over (cancelled ones excluded). */
  total: number;
  /** Cancelled member DOs — outside the ladder, reported rather than hidden. */
  cancelled: number;
};

/**
 * Null when there is nothing to roll up — no readable delivery order at all, or
 * every one of them cancelled. The caller renders a dash: an empty bucket must
 * never print a confident zero, because a company predicate that matched
 * nothing and a lorry that is genuinely empty are the same shape here.
 */
export function rollupDeliveryStatus(
  stops: readonly Pick<PackingStop, 'do_id' | 'do_status'>[],
): StatusRollup | null {
  const byDo = new Map<string, string>();
  for (const s of stops) {
    if (!s.do_id || !s.do_status) continue;
    byDo.set(s.do_id, String(s.do_status).toUpperCase());
  }
  let cancelled = 0;
  const rungs: number[] = [];
  for (const status of byDo.values()) {
    if (status === 'CANCELLED') { cancelled += 1; continue; }
    const hit = DO_RUNG.get(status);
    /* An unrecognised status is NOT folded into rung 0. It is a value nothing
       in this ladder can speak for, so it stays out of the numerator and the
       denominator rather than being reported as "Draft". */
    if (hit) rungs.push(hit.rung);
  }
  if (rungs.length === 0) return null;

  const top = Math.max(...rungs);
  const label = [...DO_RUNG.values()].find((r) => r.rung === top)?.label ?? 'Draft';
  return {
    label,
    reached: rungs.filter((r) => r >= top).length,
    total: rungs.length,
    cancelled,
  };
}

/** "Loaded 2/3", or null — same refusal as above, passed straight through. */
export function rollupLabel(rollup: StatusRollup | null): string | null {
  return rollup ? `${rollup.label} ${rollup.reached}/${rollup.total}` : null;
}

/* ── 3. Racks ─────────────────────────────────────────────────────────────── */

/** Leading integer, so "Rack 3" sorts before "Rack 20". Lifted from Hookka's
 *  `rack-format.ts` — same rule, because the same warehouse reads both sheets. */
const rackNum = (s: string): number => {
  const m = s.match(/\d+/);
  return m ? Number(m[0]) : Number.POSITIVE_INFINITY;
};

export function compareRackLabels(a: string, b: string): number {
  return rackNum(a) - rackNum(b) || a.localeCompare(b);
}

/**
 * "Rack 3, 4" — dedupe, numeric sort, print the word once. Empty string when
 * nothing resolved, so the caller prints a dash instead of "Rack".
 *
 * ONE RACK PER DELIVERY-ORDER LINE is all Houzs stores (`rack_id`, mig 0118).
 * Hookka can print per PIECE ("HB: Rack 19 / Divan: Rack 19, 20") because its
 * packing job cards carry a rack each; this system has no piece layer, and
 * inventing one would be a sheet that says more than the data does.
 */
export function formatRacksCompact(labels: readonly (string | null | undefined)[]): string {
  const seen = new Set<string>();
  for (const raw of labels) {
    const v = (raw ?? '').trim();
    if (v) seen.add(v);
  }
  if (seen.size === 0) return '';
  const sorted = [...seen].sort(compareRackLabels);
  const stripped = sorted.map((s) => s.replace(/^rack\s*/i, '').trim() || s);
  return `Rack ${stripped.join(', ')}`;
}

/* ── 4. Volume ────────────────────────────────────────────────────────────── */

/**
 * m³ from the stored milli-m³, or null when NOT ONE member delivery order
 * carried a figure. `delivery_orders.m3_total_milli` is a column that exists
 * and is not guaranteed to be filled — a printed "0.00 m³" would be a claim
 * about the load, where a dash is a report about our data.
 */
export function fmtM3(m3Milli: number | null | undefined): string | null {
  if (m3Milli == null) return null;
  return `${(m3Milli / 1000).toFixed(2)} m³`;
}

