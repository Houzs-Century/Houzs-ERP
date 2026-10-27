// ----------------------------------------------------------------------------
// do-lifecycle — the DO list's lifecycle badge from the DO's non-cancelled
// sales invoices and delivery returns, already read.
//
// Lifted out of computeDoLifecycle (routes/delivery-orders-mfg.ts) on 2026-10-23
// (HC-0002) so the list builder (lib/do-list-rows.ts) derives the badge from the
// SI / DR rows it already reads for has_children and the transfer-to columns —
// the same two tables, the same `delivery_order_id IN page` and the same
// `status <> CANCELLED` filter — instead of reading both a second time.
// ----------------------------------------------------------------------------

import { normalizeEventDay } from './date-coerce';

export type DoLifecycle = 'shipped' | 'invoiced' | 'returned';

export type DoLifecycleSi = { delivery_order_id: string | null; invoice_date: string | null; created_at: string | null };
export type DoLifecycleDr = { delivery_order_id: string | null; return_date: string | null; created_at: string | null };

export function doLifecycleFrom(
  ids: string[],
  siRows: DoLifecycleSi[],
  drRows: DoLifecycleDr[],
): Map<string, DoLifecycle> {
  const out = new Map<string, DoLifecycle>();
  type Ev = { date: string; createdAt: string; kind: DoLifecycle };
  const events = new Map<string, Ev[]>();
  const push = (doId: string | null | undefined, ev: Ev) => {
    if (!doId) return;
    const arr = events.get(doId) ?? [];
    arr.push(ev);
    events.set(doId, arr);
  };
  for (const s of siRows) {
    push(s.delivery_order_id, { date: s.invoice_date ?? s.created_at ?? '', createdAt: s.created_at ?? '', kind: 'invoiced' });
  }
  for (const r of drRows) {
    push(r.delivery_order_id, { date: r.return_date ?? r.created_at ?? '', createdAt: r.created_at ?? '', kind: 'returned' });
  }

  const priority: Record<DoLifecycle, number> = { shipped: 0, invoiced: 1, returned: 2 };
  for (const id of ids) {
    const evs = events.get(id);
    if (!evs || evs.length === 0) { out.set(id, 'shipped'); continue; }
    let best: Ev | null = null;
    for (const ev of evs) {
      if (!best) { best = ev; continue; }
      // Bug #10 — normalize mixed plain-date / ISO-timestamp business dates to a
      // day-level key before comparing (created_at remains the tie-breaker).
      const dc = normalizeEventDay(ev.date).localeCompare(normalizeEventDay(best.date));
      if (dc > 0) { best = ev; continue; }
      if (dc < 0) continue;
      const cc = ev.createdAt.localeCompare(best.createdAt);
      if (cc > 0) { best = ev; continue; }
      if (cc < 0) continue;
      if (priority[ev.kind] > priority[best.kind]) best = ev;
    }
    out.set(id, best ? best.kind : 'shipped');
  }
  return out;
}
