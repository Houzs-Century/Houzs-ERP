// ----------------------------------------------------------------------------
// propose-time — the Time page's confirmed-date discipline over the
// sequence-assign packer (owner pipeline 2026-08-07/08: dates first, lorries
// second; PR #1716 review).
//
// "Propose time" exists for DATE-CONFIRMED orders, so the proposal must land
// every order's trip ON its confirmed delivery date — the Date page owns
// dates, and the Time page must never re-derive them. The backend
// /delivery-zones/sequence-assign endpoint is untouched (no backend change):
// it still walks lorry-days forward from a start date. The Time page therefore
//
//   1. GROUPS the selected orders by their confirmed date
//      (groupByConfirmedDate — amended_delivery_date first, the live trip's
//      date next, then the effective/customer chain for a degraded cached
//      payload; a row with NO date signal is reported, never guessed),
//   2. calls the endpoint ONCE PER date-group with that date as the start, and
//   3. PINS each response to that one day (pinAssignToDate): a trip the packer
//      walked PAST the start date means the own fleet provably cannot cover
//      the confirmed date — the date is a promise to the customer, so those
//      orders spill to the 3PL overflow bucket FOR that date instead of being
//      re-dated. Overflow / unassigned rows are pinned to the same date.
//   4. mergeAssignResults folds the per-date responses into one view.
//
// The invariant this buys — every proposed stop's trip date equals its order's
// confirmed date — is pinned by propose-time.test.ts.
// ----------------------------------------------------------------------------
import type { PlanningOrder } from './delivery-planning-queries';
import type { SequenceAssignResponse } from './delivery-zones-queries';
import { warehouseLabel } from './warehouse-label';

/** The fields the date-grouping reads — a subset so tests build rows cheaply. */
export type ConfirmedDateRow = Pick<
  PlanningOrder,
  | 'row_type'
  | 'so_doc_no'
  | 'amended_delivery_date'
  | 'trip_date'
  | 'effective_delivery_date'
  | 'customer_delivery_date'
>;

/** The order's CONFIRMED delivery date (YYYY-MM-DD), or null when it has no
 *  date signal at all. amended_delivery_date IS the confirmation act (what
 *  "Apply proposed dates" / the bulk date-set write); a live trip's date is
 *  the next-strongest commitment (a TIME_ARRANGED row can sit on a trip with
 *  no amended date — the known no-DO gap); the effective/customer chain is the
 *  degraded-cache fallback only. */
export function confirmedDateOf(o: ConfirmedDateRow): string | null {
  const d = o.amended_delivery_date ?? o.trip_date ?? o.effective_delivery_date ?? o.customer_delivery_date;
  if (d == null) return null;
  const day = String(d).slice(0, 10);
  return day || null;
}

export type ConfirmedDateGroup = { date: string; docNos: string[] };

/* ── Depot derivation (owner addendum 2026-08-08: time WINDOWS, not bare ETAs).
   The sequence engine geocodes the depot ONLY when the request names a
   depotWarehouseId (delivery-zones.ts: `if (configured && depotWarehouseId)`);
   a call without one gets NO route and NO windows — the exact "ETA — / depot
   could not be geocoded" the owner screenshotted. The pages therefore derive
   the depot from the selected orders themselves: the MAJORITY warehouse among
   the rows (ties break to the first seen, deterministic), with its label kept
   so a geocode failure can name the warehouse to fix. null when no selected
   row carries a warehouse at all — a state the caller must surface loudly, not
   swallow. */

export type DepotRow = Pick<PlanningOrder, 'row_type' | 'so_doc_no' | 'warehouse_id' | 'warehouse_name' | 'warehouse_code'>;

export type DepotPick = { warehouseId: string; label: string };

export function depotForDocNos(orders: DepotRow[], docNos: string[]): DepotPick | null {
  const wanted = new Set(docNos);
  const votes = new Map<string, { count: number; label: string; seen: number }>();
  let seen = 0;
  for (const o of orders) {
    if (o.row_type !== 'so' || !wanted.has(o.so_doc_no) || !o.warehouse_id) continue;
    const cur = votes.get(o.warehouse_id);
    if (cur) cur.count += 1;
    else votes.set(o.warehouse_id, {
      count: 1,
      label: warehouseLabel({ code: o.warehouse_code, name: o.warehouse_name }) ?? o.warehouse_id,
      seen: seen++,
    });
  }
  let best: { id: string; count: number; label: string; seen: number } | null = null;
  for (const [id, v] of votes) {
    if (!best || v.count > best.count || (v.count === best.count && v.seen < best.seen)) {
      best = { id, ...v };
    }
  }
  return best ? { warehouseId: best.id, label: best.label } : null;
}

/** Split a selection into per-confirmed-date groups (dates ascending, doc
 *  order preserved within a group) plus the undated leftovers — those belong
 *  to the Date page and are REPORTED to the operator, never silently dated. */
export function groupByConfirmedDate(
  orders: ConfirmedDateRow[],
  selectedDocNos: string[],
): { groups: ConfirmedDateGroup[]; undated: string[] } {
  const byDoc = new Map<string, ConfirmedDateRow>();
  for (const o of orders) if (o.row_type === 'so') byDoc.set(o.so_doc_no, o);
  const byDate = new Map<string, string[]>();
  const undated: string[] = [];
  for (const docNo of selectedDocNos) {
    const row = byDoc.get(docNo);
    const date = row ? confirmedDateOf(row) : null;
    if (!date) { undated.push(docNo); continue; }
    const arr = byDate.get(date) ?? [];
    arr.push(docNo);
    byDate.set(date, arr);
  }
  const groups = [...byDate.entries()]
    .map(([date, docNos]) => ({ date, docNos }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { groups, undated };
}

/** Constrain one sequence-assign response to ONE day — the group's confirmed
 *  date. Trips the packer placed on that day pass through (key namespaced by
 *  the date so merged results can never collide). Trips walked PAST the day
 *  become 3PL-overflow groups FOR the confirmed date: the packer only starts a
 *  later day when every eligible lorry is at cap, so a walked-past trip is
 *  exactly "own fleet full on the confirmed date". Overflow and unassigned
 *  rows are pinned to the date too. Nothing is ever re-dated. */
export function pinAssignToDate(r: SequenceAssignResponse, date: string): SequenceAssignResponse {
  const trips = [];
  const spilled = [];
  for (const t of r.trips) {
    if (t.date === date) {
      trips.push({ ...t, key: `${date}|${t.key}` });
    } else {
      spilled.push({
        key: `${date}|spill|${t.key}`,
        date,
        group: t.group,
        orders: t.stops.map((s) => s.ref),
        sets: t.sets,
        revenueSen: t.revenueSen,
        reason: `own fleet full on ${date} — could not fit these on the confirmed date`,
      });
    }
  }
  return {
    ...r,
    startDate: date,
    trips,
    overflow: [
      ...r.overflow.map((o) => ({ ...o, key: `${date}|${o.key}`, date })),
      ...spilled,
    ],
    unassigned: r.unassigned.map((u) => ({ ...u, date })),
  };
}

/** Fold the per-date (already pinned) responses into one view for the page.
 *  Fleet-level facts (lorry counts, exclusions, carriers, depot, config) are
 *  the same fleet read repeated per call — deduped / taken from the first;
 *  `configured` is honest only if EVERY call had the maps key. */
export function mergeAssignResults(results: SequenceAssignResponse[]): SequenceAssignResponse | null {
  if (results.length === 0) return null;
  const first = results[0];
  const dedupeById = <T extends { id: string }>(lists: T[][]): T[] => {
    const seen = new Map<string, T>();
    for (const list of lists) for (const item of list) if (!seen.has(item.id)) seen.set(item.id, item);
    return [...seen.values()];
  };
  return {
    ...first,
    startDate: results.map((r) => r.startDate).sort()[0],
    configured: results.every((r) => r.configured),
    usingDefaultZoneMap: results.some((r) => r.usingDefaultZoneMap),
    trips: results.flatMap((r) => r.trips)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.group.localeCompare(b.group))),
    excludedLorries: dedupeById(results.map((r) => r.excludedLorries)),
    excludedDrivers: dedupeById(results.map((r) => r.excludedDrivers)),
    carriers: dedupeById(results.map((r) => r.carriers)),
    overflow: results.flatMap((r) => r.overflow),
    unassigned: results.flatMap((r) => r.unassigned),
  };
}
