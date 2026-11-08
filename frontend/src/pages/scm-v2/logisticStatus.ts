// Logistic Overview · order-status breakdowns (owner 2026-11-04): the share of
// orders by delivery PROGRESS (the board's derived state) and by customer
// MESSAGE status (the Delivery Planning follow-up field). Both are pure counts
// over the board's SO rows, so they live here with their own test and the page
// only renders the result.
import { DELIVERY_STATES, DELIVERY_STATE_LABEL, type PlanningOrder } from "../../vendor/scm/lib/delivery-planning-queries";

export type StatusSlice = { key: string; label: string; count: number; sen: number; pct: number };

/** Blank / unset message status reads as this bucket. */
export const NO_MESSAGE_STATUS = "No status yet";

function withPct(
  rows: Array<{ key: string; label: string; count: number; sen: number }>,
  total: number,
): StatusSlice[] {
  return rows.map((r) => ({ ...r, pct: total ? Math.round((r.count / total) * 1000) / 10 : 0 }));
}

/** Orders by their derived delivery progress, in the board's tab order
 *  (Pending Delivery · Pending Schedule · Overdue · Delivered). Zero-count
 *  states are dropped; the share denominator is every row passed in. */
/** The board's Delivered split in two: the delivery orders closed as delivered, and those
 *  only out on the lorry (owner 2026-11-07). */
export const OUT_NOT_CLOSED = "OUT_NOT_CLOSED";

export const progressKeyOf = (o: PlanningOrder, done: (o: PlanningOrder) => boolean): string =>
  o.delivery_state === "DELIVERED" && !done(o) ? OUT_NOT_CLOSED : o.delivery_state;

export function deliveryProgressBreakdown(rows: PlanningOrder[], done: (o: PlanningOrder) => boolean): StatusSlice[] {
  const by = new Map<string, { count: number; sen: number }>();
  for (const o of rows) {
    const k = progressKeyOf(o, done);
    const g = by.get(k) ?? { count: 0, sen: 0 };
    g.count += 1;
    g.sen += o.local_total_sen;
    by.set(k, g);
  }
  const out = [...DELIVERY_STATES.slice(0, -1), OUT_NOT_CLOSED, ...DELIVERY_STATES.slice(-1)]
    .map((s) => ({ key: s, label: s === OUT_NOT_CLOSED ? "Out, not closed" : DELIVERY_STATE_LABEL[s as keyof typeof DELIVERY_STATE_LABEL], count: by.get(s)?.count ?? 0, sen: by.get(s)?.sen ?? 0 }))
    .filter((r) => r.count > 0);
  return withPct(out, rows.length);
}

/** Orders by their customer-message workflow status (the raw value, blank →
 *  "No status yet"), biggest first. */
export const messageStatusOf = (o: PlanningOrder): string => o.delivery_message_status?.trim() || NO_MESSAGE_STATUS;

/** The orders behind one row of the message-status table; "__other__" is every status
 *  not shown on its own row. */
export function ordersOfSlice(rows: PlanningOrder[], key: string, shown: readonly StatusSlice[]): PlanningOrder[] {
  if (key !== "__other__") return rows.filter((o) => messageStatusOf(o) === key);
  const own = new Set(shown.map((s) => s.key));
  return rows.filter((o) => !own.has(messageStatusOf(o)));
}

export function messageStatusBreakdown(rows: PlanningOrder[]): StatusSlice[] {
  const by = new Map<string, { count: number; sen: number }>();
  for (const o of rows) {
    const k = messageStatusOf(o);
    const g = by.get(k) ?? { count: 0, sen: 0 };
    g.count += 1;
    g.sen += o.local_total_sen;
    by.set(k, g);
  }
  const out = [...by.entries()]
    .map(([label, g]) => ({ key: label, label, count: g.count, sen: g.sen }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return withPct(out, rows.length);
}

/** Keep the top `n` slices and fold the rest into one "Other (k)" row, so a long
 *  tail of tiny statuses does not stretch the table. The share is recomputed
 *  from the untruncated total. */
export function topWithOther(slices: StatusSlice[], n: number): StatusSlice[] {
  if (slices.length <= n) return slices;
  const total = slices.reduce((a, s) => a + s.count, 0);
  const tail = slices.slice(n);
  const count = tail.reduce((a, s) => a + s.count, 0);
  const sen = tail.reduce((a, s) => a + s.sen, 0);
  return [
    ...slices.slice(0, n),
    { key: "__other__", label: `Other (${tail.length})`, count, sen, pct: total ? Math.round((count / total) * 1000) / 10 : 0 },
  ];
}
