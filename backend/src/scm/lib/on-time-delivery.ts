/* On-time delivery, worked out ONCE on the server (owner 2026-11-08, sister review A3).
   The Logistic Overview and Lorry Capacity read it; neither works it out.

   Promised date = the SO's delivery date as the board defines "due": the amended date,
   else the customer's date (`effectiveSoDelivery` on the header, as lorry-day-runs uses
   for "SOs due that day").
   Delivered date = the Malaysia (UTC+8) calendar date of `delivered_at` on the SO's latest
   live DO (not cancelled, newest by created_at: `latestLiveDoIdForSo`'s rule).
   On time = delivered on the promised date; Early = before; Late = after.
   On-time rate = (on time + early) / delivered in the period.
   Late-open = not delivered, promised date in the period and before today. Listed on its
   own, never in the rate.
   East Malaysia and Singapore orders are left out, as on the Last Mile board
   (`offPeninsula`); their count is reported so nothing disappears silently. */

import { effectiveSoDelivery } from '../shared/effective-delivery';
import { mytDateOf } from './my-time';

export type OnTimeResult = 'ON_TIME' | 'EARLY' | 'LATE' | 'LATE_OPEN' | 'OPEN' | 'NO_DATE';

const DAY = 86400000;
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY);

/** The promised date of an SO header: amended, else the customer's. */
export function promisedDateOf(so: { amended_delivery_date: string | null; customer_delivery_date: string | null }): string | null {
  return effectiveSoDelivery({ amended_delivery_date: so.amended_delivery_date, customer_delivery_date: so.customer_delivery_date });
}

/** The Malaysia calendar date of a delivery stamp. A bare date is already a day. */
export function deliveredMyDate(deliveredAt: string | null): string | null {
  if (!deliveredAt) return null;
  const s = String(deliveredAt).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  return Number.isFinite(t) ? mytDateOf(t) : null;
}

/** One order's result. `daysLate` is delivered minus promised (negative = early); for a
 *  late-open order it is today minus promised. PURE. */
export function classifyOnTime(promised: string | null, deliveredAt: string | null, today: string): { result: OnTimeResult; delivered: string | null; daysLate: number | null } {
  const delivered = deliveredMyDate(deliveredAt);
  if (!promised) return { result: 'NO_DATE', delivered, daysLate: null };
  if (delivered) {
    const d = dayDiff(delivered, promised);
    return { result: d === 0 ? 'ON_TIME' : d < 0 ? 'EARLY' : 'LATE', delivered, daysLate: d };
  }
  if (promised < today) return { result: 'LATE_OPEN', delivered: null, daysLate: dayDiff(today, promised) };
  return { result: 'OPEN', delivered: null, daysLate: null };
}

/** The SO's latest live DO: not cancelled, newest by created_at (ties by id). PURE. */
export function latestLiveDo<T extends { id: string; status: string | null; created_at: string | null }>(dos: readonly T[]): T | null {
  let best: T | null = null;
  for (const d of dos) {
    if (String(d.status ?? '').toUpperCase() === 'CANCELLED') continue;
    if (!best || String(d.created_at ?? '') > String(best.created_at ?? '') || (String(d.created_at ?? '') === String(best.created_at ?? '') && d.id > best.id)) best = d;
  }
  return best;
}

export interface OnTimeOrderIn {
  soDocNo: string; customer: string | null; promised: string | null;
  /** delivered_at of the latest live DO when that DO is DELIVERED, else null. */
  deliveredAt: string | null;
  /** The SO is closed (DELIVERED / INVOICED / CLOSED) but its latest live DO carries no delivery time. */
  closedWithoutTime: boolean;
  region: string; offPeninsula: boolean;
  lorryId: string | null; lorry: string | null; driver: string | null;
}

export interface OnTimeOrderRow {
  soDocNo: string; customer: string | null; promised: string; delivered: string | null;
  daysLate: number; result: 'ON_TIME' | 'EARLY' | 'LATE' | 'LATE_OPEN';
  region: string; lorryId: string | null; lorry: string | null; driver: string | null;
}

export interface OnTimeGroup {
  key: string; lorryId: string | null;
  delivered: number; onTime: number; early: number; late: number; lateOpen: number;
  /** (on time + early) / delivered, percent to one decimal; null when nothing was delivered. */
  ratePct: number | null;
}

const NONE = 'Not recorded';
const pct = (good: number, all: number) => (all ? Math.round((good / all) * 1000) / 10 : null);

/** The period's figures. PURE. */
export function onTimeSummary(orders: readonly OnTimeOrderIn[], from: string, to: string, today: string) {
  const rows: OnTimeOrderRow[] = [];
  let offPeninsula = 0, noPromise = 0, noDeliveryTime = 0;
  for (const o of orders) {
    const c = classifyOnTime(o.promised, o.deliveredAt, today);
    const inPeriod = c.delivered
      ? c.delivered >= from && c.delivered <= to
      : !!o.promised && o.promised >= from && o.promised <= to && o.promised < today;
    if (!inPeriod) continue;
    if (o.offPeninsula) { offPeninsula += 1; continue; }
    if (c.result === 'NO_DATE') { noPromise += 1; continue; }
    if (c.result === 'LATE_OPEN' && o.closedWithoutTime) { noDeliveryTime += 1; continue; }
    if (c.result === 'OPEN') continue;
    rows.push({ soDocNo: o.soDocNo, customer: o.customer, promised: o.promised as string, delivered: c.delivered, daysLate: c.daysLate as number, result: c.result, region: o.region, lorryId: o.lorryId, lorry: o.lorry, driver: o.driver });
  }
  const group = (keyOf: (r: OnTimeOrderRow) => string, idOf: (r: OnTimeOrderRow) => string | null): OnTimeGroup[] => {
    const m = new Map<string, OnTimeGroup>();
    for (const r of rows) {
      const k = keyOf(r);
      const g = m.get(k) ?? { key: k, lorryId: idOf(r), delivered: 0, onTime: 0, early: 0, late: 0, lateOpen: 0, ratePct: null };
      if (r.result === 'LATE_OPEN') g.lateOpen += 1;
      else { g.delivered += 1; if (r.result === 'ON_TIME') g.onTime += 1; else if (r.result === 'EARLY') g.early += 1; else g.late += 1; }
      g.lorryId = g.lorryId ?? idOf(r);
      m.set(k, g);
    }
    return [...m.values()].map((g) => ({ ...g, ratePct: pct(g.onTime + g.early, g.delivered) }))
      .sort((a, b) => Number(a.key === NONE) - Number(b.key === NONE) || b.delivered - a.delivered || a.key.localeCompare(b.key));
  };
  const all = group(() => 'all', () => null)[0] as OnTimeGroup | undefined;
  /* Late-open first, then late, early, on time: open orders, then by days late. */
  const rank = (r: OnTimeOrderRow) => (r.delivered === null ? 0 : r.daysLate > 0 ? 1 : r.daysLate < 0 ? 2 : 3);
  return {
    from, to,
    delivered: all?.delivered ?? 0, onTime: all?.onTime ?? 0, early: all?.early ?? 0, late: all?.late ?? 0, lateOpen: all?.lateOpen ?? 0,
    ratePct: all?.ratePct ?? null,
    byLorry: group((r) => r.lorry ?? NONE, (r) => r.lorryId),
    byDriver: group((r) => r.driver ?? NONE, () => null),
    byRegion: group((r) => r.region, () => null),
    /* Left out, counted so the reader sees them. */
    excluded: { offPeninsula, noPromise, noDeliveryTime },
    orders: rows.sort((a, b) => rank(a) - rank(b) || b.daysLate - a.daysLate || a.soDocNo.localeCompare(b.soDocNo)),
  };
}

export type OnTimeSummary = ReturnType<typeof onTimeSummary>;
