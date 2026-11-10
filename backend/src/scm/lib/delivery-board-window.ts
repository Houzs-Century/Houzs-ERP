/* Which rows a GET /delivery-planning builds in full (the per-order reads:
   lines, deliverable sums, DOs, crew, trips, balances, PO numbers), decided
   BEFORE those reads, because they were what made the board slow (production
   2026-11: p95 13.9 s, ~800-1,400 DB calls on the default state=ALL load, the
   Worker limit is 1,000).

   1. Date bands (owner 2026-11-10). ?band=N&page=P builds only the rows whose
      EFFECTIVE delivery date (amended ?? customer, the date days_left counts
      from) lies in band N, on BOTH sides of today:
        1 = within 15 days, 2 = 16-30, 3 = 31-60, 4 = 61-90,
        5 = more than 90 days away, or no delivery date (processing date only).
      Open and delivered orders alike; an order 20 days overdue is in band 2. The
      band is filtered IN the header query, so band 1 never scans every SO. Every
      row has one effective date, so it is in exactly one band: bands 1-5 together
      are exactly the full board. Sub-board rows (service case, DP job, project)
      are banded by the same field, and ride page 0 only.
   2. ?counts_only=1: the tab counts for every region, without the display reads
      (DOs, crew, trips, balances, PO numbers). Fired next to band 1 so counts are
      right before the rows arrive.
   3. state=OPEN and counts: a status-DELIVERED order is Delivered whatever else
      holds, so it is counted from its header and not built (2026-10-26 rule).
   4. A self-scoped Driver / Helper: only SOs that one of their own DOs or crew
      seats points at are built. applyDeliveryRowScope still decides per row on
      the latest DO afterwards, so this is a superset and their board is
      byte-identical.
   No band and no counts_only = the whole board, as before, for every other caller. */
import type { Context } from 'hono';
import { paginateAll, inList } from './paginate-all';
import { splitDeliveredForOpen } from './delivery-board-slice';
import type { DeliveryScope } from './deliveryScope';
import type { Env, Variables } from '../env';

export type BandNo = 1 | 2 | 3 | 4 | 5;
/** [nearest, farthest] days from today, both sides; band 5 is open-ended plus undated. */
export const BANDS: ReadonlyArray<{ band: BandNo; near: number; far: number | null; label: string }> = [
  { band: 1, near: 0, far: 15, label: 'within 15 days' },
  { band: 2, near: 16, far: 30, label: '16-30 days' },
  { band: 3, near: 31, far: 60, label: '31-60 days' },
  { band: 4, near: 61, far: 90, label: '61-90 days' },
  { band: 5, near: 91, far: null, label: 'over 90 days or no date' },
];
/** SO rows per band page: about 8 doc_no chunks per per-order read. */
export const BAND_PAGE_SIZE = 1500;

const shift = (today: string, n: number): string =>
  new Date(new Date(`${today}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

/** The band of an effective delivery date (YYYY-MM-DD or null). */
export function bandOf(effective: string | null | undefined, today: string): BandNo {
  const d = effective ? String(effective).slice(0, 10) : '';
  if (!d) return 5;
  const days = Math.abs(Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000));
  for (const b of BANDS) if (b.far != null && days <= b.far) return b.band;
  return 5;
}

export type BandParams = { band: BandNo; page: number } | null | 'invalid';

/** ?band=1..5&page=N (both, or neither = the whole board). */
export function parseBand(band: string | undefined, page: string | undefined): BandParams {
  if (band == null && page == null) return null;
  if (!band || !/^[1-5]$/.test(band) || !page || !/^\d{1,4}$/.test(page)) return 'invalid';
  return { band: Number(band) as BandNo, page: Number(page) };
}

/** The PostgREST `or` that keeps SO headers whose amended ?? customer date is in the band. */
export function bandHeaderOr(band: BandNo, today: string): string {
  const b = BANDS[band - 1]!;
  const A = 'amended_delivery_date'; const C = 'customer_delivery_date';
  const ranges: Array<[string, string]> = b.far == null ? [] : b.near === 0
    ? [[shift(today, -b.far), shift(today, b.far)]]
    : [[shift(today, -b.far), shift(today, -b.near)], [shift(today, b.near), shift(today, b.far)]];
  if (b.far != null) {
    return ranges.flatMap(([lo, hi]) => [`and(${A}.gte.${lo},${A}.lte.${hi})`, `and(${A}.is.null,${C}.gte.${lo},${C}.lte.${hi})`]).join(',');
  }
  const lo = shift(today, -(b.near - 1)); const hi = shift(today, b.near - 1);
  return [`${A}.lt.${lo}`, `${A}.gt.${hi}`, `and(${A}.is.null,${C}.lt.${lo})`, `and(${A}.is.null,${C}.gt.${hi})`, `and(${A}.is.null,${C}.is.null)`].join(',');
}

/** The same band as bandHeaderOr, as dates for the SQL board path
 *  (delivery-board-sql.ts): `inside` = coalesce(amended, customer) falls in one of
 *  the ranges; `outside` (band 5) = it is null, or before lo, or after hi.
 *  amended ?? customer is exactly bandHeaderOr's "amended, or customer when amended is null". */
export function bandDateRanges(band: BandNo, today: string): { inside: Array<[string, string]> | null; outside: [string, string] | null } {
  const b = BANDS[band - 1]!;
  if (b.far == null) return { inside: null, outside: [shift(today, -(b.near - 1)), shift(today, b.near - 1)] };
  const inside: Array<[string, string]> = b.near === 0
    ? [[shift(today, -b.far), shift(today, b.far)]]
    : [[shift(today, -b.far), shift(today, -b.near)], [shift(today, b.near), shift(today, b.far)]];
  return { inside, outside: null };
}

/** Narrow the SO header read to a band; the whole board otherwise. */
export function bandFilter<Q extends { or: (expr: string) => Q }>(q: Q, band: BandParams, today: string): Q {
  return band && band !== 'invalid' ? q.or(bandHeaderOr(band.band, today)) : q;
}

/** A band request answers with its own rows only; sub-board rows ride page 0. */
export function bandRows<T extends { row_type: string; effective_delivery_date: string | null }>(rows: T[], band: BandParams, today: string): T[] {
  if (!band || band === 'invalid') return rows;
  return rows.filter((o) => bandOf(o.effective_delivery_date, today) === band.band && (o.row_type === 'so' || band.page === 0));
}

/** SO doc numbers a self-scoped caller's own DOs point at: the DO header driver,
 *  or any crew seat. Not company-predicated on purpose: the result only ever
 *  narrows the already company-scoped SO header rows (intersection), exactly as
 *  the board's own DO read by so_doc_no does. */
async function ownSoDocs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm service client
  sb: any,
  scope: Extract<DeliveryScope, { mode: 'self' }>,
): Promise<{ ok: Set<string> } | { err: unknown }> {
  const drivers = [...scope.driverIds];
  const helpers = [...scope.helperIds];
  if (drivers.length === 0 && helpers.length === 0) return { ok: new Set() };
  const seats = [
    ...(drivers.length ? [`driver_1_id.in.${inList(drivers)}`, `driver_2_id.in.${inList(drivers)}`] : []),
    ...(helpers.length ? [`helper_1_id.in.${inList(helpers)}`, `helper_2_id.in.${inList(helpers)}`] : []),
  ].join(',');
  const [byHeader, byCrew] = await Promise.all([
    drivers.length
      ? paginateAll<{ so_doc_no: string | null }>((from, to) => sb.from('delivery_orders').select('so_doc_no').in('driver_id', drivers).order('id').range(from, to))
      : Promise.resolve({ data: [], error: null }),
    paginateAll<{ do_id: string | null }>((from, to) => sb.from('delivery_order_crew').select('do_id').or(seats).order('do_id').range(from, to)),
  ]);
  if (byHeader.error) return { err: byHeader.error };
  if (byCrew.error) return { err: byCrew.error };
  const docs = new Set((byHeader.data ?? []).map((d) => String(d.so_doc_no ?? '')).filter(Boolean));
  const doIds = [...new Set((byCrew.data ?? []).map((d) => String(d.do_id ?? '')).filter(Boolean))];
  for (let i = 0; i < doIds.length; i += 100) {
    const batch = doIds.slice(i, i + 100);
    const { data, error } = await paginateAll<{ so_doc_no: string | null }>((from, to) =>
      sb.from('delivery_orders').select('so_doc_no').in('id', batch).order('id').range(from, to));
    if (error) return { err: error };
    for (const d of data ?? []) if (d.so_doc_no) docs.add(String(d.so_doc_no));
  }
  return { ok: docs };
}

/** Split the dated SO header rows into the ones to build and the ones only to count. */
export async function planBoardSoRows<T extends { doc_no: string | null; status: string | null }>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm service client
  sb: any,
  _c: Context<{ Bindings: Env; Variables: Variables }>,
  input: { rows: T[]; stateParam: string; scope: DeliveryScope; band: BandParams; countsOnly: boolean },
): Promise<{ kept: T[]; skipped: T[]; pageCount: number | null } | { stage: string; err: unknown }> {
  const { stateParam, scope, band, countsOnly } = input;
  let { rows } = input;
  if (scope.mode === 'self') {
    const own = await ownSoDocs(sb, scope);
    if ('err' in own) return { stage: 'own_jobs', err: own.err };
    rows = rows.filter((r) => own.ok.has(String(r.doc_no ?? '')));
  }
  const split = (stateParam === 'OPEN' || countsOnly) && scope.mode === 'all';
  const { kept, skipped } = splitDeliveredForOpen(rows, split);
  if (!band || band === 'invalid') return { kept, skipped, pageCount: null };
  const from = band.page * BAND_PAGE_SIZE;
  return {
    kept: kept.slice(from, from + BAND_PAGE_SIZE),
    skipped: band.page === 0 ? skipped : [], // counted once, on page 0
    pageCount: Math.max(1, Math.ceil(kept.length / BAND_PAGE_SIZE)),
  };
}

/** counts_only: the tab counts per region key (and ALL), built rows plus header-counted Delivered. */
export function countsByRegion<R extends { delivery_state: string }, S>(
  rows: R[],
  skipped: S[],
  regionKeys: readonly string[],
  matches: (o: R, region: string) => boolean,
  regionsOfSkipped: (s: S) => readonly string[],
  empty: () => Record<string, number>,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const key of ['ALL', ...regionKeys]) {
    const c = empty();
    // empty() holds ALL and every state at 0.
    for (const o of rows) if (matches(o, key)) { c[o.delivery_state] += 1; c.ALL += 1; }
    for (const s of skipped) if (key === 'ALL' || regionsOfSkipped(s).includes(key)) { c.DELIVERED += 1; c.ALL += 1; }
    out[key] = c;
  }
  return out;
}
