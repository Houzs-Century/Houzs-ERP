// ----------------------------------------------------------------------------
// pos-sales-place — the "showroom or roadshow event" picker on the 2990 POS
// My-orders board. PURE: no I/O, no client, no env.
//
// Owner 2026-10-30: the board and its two tiles pooled every showroom and every
// roadshow into one figure, "difficult to manage"; he wants to pick a showroom,
// or a roadshow and WHICH event. So the period's orders are split two ways:
//
//   - linked to an event (`project_id`, set by the fair link on create and by
//     the nightly reconcile) -> that event;
//   - linked to none -> the venue it was sold at (a showroom, normally). The
//     POS handover requires a venue; a blank one is its own entry.
//
// Every order lands in exactly one entry, so the entries add up to the tile.
// GET /pos/sales-stats and GET /mfg-sales-orders/mine narrow by the same pick
// (`?project=` or `?venue=`) with the same rule, so the board shows the orders
// the tiles above it count.
// ----------------------------------------------------------------------------

import { escapeLikeLiteral } from './fulfillment-costing';
import type { FairProjectRow } from './fair-options';

/** `?venue=` asking for the unlinked orders with no venue recorded. */
export const NO_VENUE = '__none__';

/** What the board and its tiles are narrowed to. */
export type SalesPlace =
  /** One event (a PMS project): the orders linked to it. */
  | { kind: 'event'; projectId: number }
  /** One venue's orders that are linked to no event. NO_VENUE = none recorded. */
  | { kind: 'venue'; venue: string };

const PROJECT_ID = /^[1-9]\d{0,9}$/;
const INT4_MAX = 2147483647;

/** `?project=` / `?venue=` -> the pick. A project id wins; a malformed one is
 *  ignored rather than sent to an integer column, where it would be a 500. */
export function readSalesPlace(
  project: string | undefined,
  venue: string | undefined,
): SalesPlace | null {
  const p = (project ?? '').trim();
  if (PROJECT_ID.test(p) && Number(p) <= INT4_MAX) return { kind: 'event', projectId: Number(p) };
  const v = (venue ?? '').trim();
  return v === '' ? null : { kind: 'venue', venue: v };
}

/** The pick as a raw-SQL clause on scm.mfg_sales_orders, for /pos/sales-stats.
 *  A venue matches as the venue master's unique name does: case and outer
 *  spaces ignored. */
export function salesPlaceSql(place: SalesPlace | null): { sql: string; binds: Array<string | number> } | null {
  if (place === null) return null;
  if (place.kind === 'event') return { sql: 'project_id = ?', binds: [place.projectId] };
  if (place.venue === NO_VENUE) return { sql: "project_id IS NULL AND NULLIF(btrim(venue), '') IS NULL", binds: [] };
  return { sql: 'project_id IS NULL AND lower(btrim(venue)) = lower(?)', binds: [place.venue] };
}

/** The builder surface `applySalesPlace` needs (structural, so tests can fake it). */
export type SalesPlaceFilterable<Q> = {
  eq(column: string, value: number): Q;
  is(column: string, value: null): Q;
  ilike(column: string, pattern: string): Q;
  or(filters: string): Q;
};

/** The same pick on a PostgREST builder, for /mine. Stored venues are trimmed
 *  on write (mig 0229), so `ilike` with the LIKE characters escaped is the SQL
 *  clause's equality; "none recorded" also catches a venue of only spaces. */
export function applySalesPlace<Q extends SalesPlaceFilterable<Q>>(query: Q, place: SalesPlace | null): Q {
  if (place === null) return query;
  if (place.kind === 'event') return query.eq('project_id', place.projectId);
  const unlinked = query.is('project_id', null);
  if (place.venue === NO_VENUE) return unlinked.or('venue.is.null,venue.match.^\\s*$');
  return unlinked.ilike('venue', escapeLikeLiteral(place.venue));
}

export type SalesPlaceEntry =
  | {
      kind: 'venue';
      /** As stored; null for the orders with no venue recorded. */
      venue: string | null;
      count: number;
    }
  | {
      kind: 'event';
      projectId: number;
      /** The event's facts, for the POS to label in its own date style — the
       *  house `MM/DD` here reads as day-first on a Malaysian tablet. All null
       *  when the project could not be read; its orders still count. */
      venue: string | null;
      organizer: string | null;
      /** A solo roadshow: no organizer to name (the SO fair picker shows SOLO). */
      solo: boolean;
      brand: string | null;
      startDate: string | null;
      endDate: string | null;
      count: number;
    };

const text = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
};

/**
 * The facet query's rows (`projectid`, `venuename`, `cnt` — one per event and
 * one per unlinked venue) -> the picker's entries: venues by name with "none
 * recorded" last, then events by start date.
 *
 * @param events The linked projects by id, as `loadFairsByIds` reads them.
 */
export function salesPlaceFacet(
  rows: ReadonlyArray<Record<string, unknown>>,
  events: ReadonlyMap<number, FairProjectRow>,
): SalesPlaceEntry[] {
  const venues: Array<Extract<SalesPlaceEntry, { kind: 'venue' }>> = [];
  const linked: Array<Extract<SalesPlaceEntry, { kind: 'event' }>> = [];
  for (const r of rows) {
    const count = Number(r.cnt ?? 0);
    if (!Number.isFinite(count) || count <= 0) continue;
    const projectId = r.projectid == null ? NaN : Number(r.projectid);
    if (Number.isInteger(projectId)) {
      const row = events.get(projectId);
      linked.push({
        kind: 'event', projectId,
        venue: text(row?.venue), organizer: text(row?.organizer),
        solo: (row?.eventType ?? '').trim().toLowerCase() === 'solo',
        brand: text(row?.brand), startDate: text(row?.startDate), endDate: text(row?.endDate),
        count,
      });
      continue;
    }
    const name = typeof r.venuename === 'string' ? r.venuename.trim() : '';
    venues.push({ kind: 'venue', venue: name === '' ? null : name, count });
  }
  venues.sort((a, b) => {
    if (a.venue === null) return b.venue === null ? 0 : 1;
    if (b.venue === null) return -1;
    return a.venue.localeCompare(b.venue, 'en', { sensitivity: 'base' });
  });
  linked.sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? '') || a.projectId - b.projectId);
  return [...venues, ...linked];
}
