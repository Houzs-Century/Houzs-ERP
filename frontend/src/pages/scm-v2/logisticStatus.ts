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
export function deliveryProgressBreakdown(rows: PlanningOrder[]): StatusSlice[] {
  const by = new Map<string, { count: number; sen: number }>();
  for (const o of rows) {
    const g = by.get(o.delivery_state) ?? { count: 0, sen: 0 };
    g.count += 1;
    g.sen += o.local_total_sen;
    by.set(o.delivery_state, g);
  }
  const out = DELIVERY_STATES
    .map((s) => ({ key: s, label: DELIVERY_STATE_LABEL[s], count: by.get(s)?.count ?? 0, sen: by.get(s)?.sen ?? 0 }))
    .filter((r) => r.count > 0);
  return withPct(out, rows.length);
}

/** Orders by their customer-message workflow status (the raw value, blank →
 *  "No status yet"), biggest first. */
export function messageStatusBreakdown(rows: PlanningOrder[]): StatusSlice[] {
  const by = new Map<string, { count: number; sen: number }>();
  for (const o of rows) {
    const k = o.delivery_message_status?.trim() || NO_MESSAGE_STATUS;
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
