/* The Delivery Planning board loads in date bands, nearest first (owner 2026-11-10).

   Each order's EFFECTIVE delivery date (amended ?? customer date, the one
   days_left counts from) puts it in one band, on both sides of today:
     1 = within 15 days, 2 = 16-30, 3 = 31-60, 4 = 61-90,
     5 = more than 90 days away, or no delivery date.
   Band 1 renders as soon as it arrives; the others follow in the background
   (GET /delivery-planning?band=N&page=P, each its own cheap request). Bands 1-5
   together are exactly the full board (proved server-side in
   delivery-planning.bands.test.ts).

   At most BOARD_MAX_IN_FLIGHT board requests run at once per tab, nearest band
   first (runBoardRequest): a board open or a full re-read used to fire all five
   bands plus counts_only together, and every open tab did so within the same
   30 s, which piled up on the database (production 2026-11-10: p95 208 s).
   Every band is queued at once, so the next starts the moment a slot frees,
   without waiting for the previous band to render.

   Nothing goes missing silently: the tab counts come from ?counts_only=1, fired
   with band 1, until every band is in; the page names the band still loading; a
   band that fails is shown with Retry and the rows after it wait. Band caches live under
   ['delivery-planning', 'ALL', state, 'band', n], so the after-edit row refresh
   and the 30 s change poll keep them current like the old single board; a row
   that sits in two caches after a refresh is shown once. */
import { useMemo } from 'react';
import { useQueries, useQuery, type QueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { planningCountsFrom, type PlanningCounts, type PlanningOrder, type PlanningResponse } from './delivery-planning-queries';

export type BandNo = 1 | 2 | 3 | 4 | 5;
export const BAND_LABEL: Record<BandNo, string> = {
  1: 'within 15 days', 2: '16-30 days', 3: '31-60 days', 4: '61-90 days', 5: 'over 90 days or no date',
};
const BAND_FAR: Array<[BandNo, number]> = [[1, 15], [2, 30], [3, 60], [4, 90]];

/** The band of a YYYY-MM-DD day (same rule as the server's bandOf). */
export function bandOfDay(day: string | null, today: string): BandNo {
  if (!day) return 5;
  const days = Math.abs(Math.round((Date.parse(`${day.slice(0, 10)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000));
  for (const [band, far] of BAND_FAR) if (days <= far) return band;
  return 5;
}

/** Load order: the page's own band first, then the rest nearest first. */
export function bandOrder(first: BandNo): BandNo[] {
  return [first, ...([1, 2, 3, 4, 5] as BandNo[]).filter((b) => b !== first)];
}

type BandPage = PlanningResponse & { band?: { band: number; page: number; page_count: number } };

/** Board requests (bands, counts_only) running at once in this tab. */
export const BOARD_MAX_IN_FLIGHT = 2;
/** counts_only's place in the queue: right after the first band. */
export const COUNTS_PRIORITY = 1.5;

/** A queue of board requests: at most `max` at once, lowest priority number first, FIFO among equals. */
export function createRequestLimiter(max: number) {
  let running = 0;
  let seq = 0;
  const queue: Array<{ priority: number; seq: number; start: () => void }> = [];
  const pump = () => {
    while (running < max && queue.length > 0) {
      queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      running += 1;
      queue.shift()!.start();
    }
  };
  return {
    run<T>(priority: number, fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push({
          priority, seq: seq++,
          start: () => { fn().then(resolve, reject).finally(() => { running -= 1; pump(); }); },
        });
        pump();
      });
    },
    get inFlight() { return running; },
  };
}

const boardLimiter = createRequestLimiter(BOARD_MAX_IN_FLIGHT);

/** Run one board request through this tab's queue (priority: lower runs first). */
export function runBoardRequest<T>(priority: number, fn: () => Promise<T>): Promise<T> {
  return boardLimiter.run(priority, fn);
}

/** Every page of one band, as one response: rows joined, counts and delivered tallies summed. */
async function fetchBand(band: BandNo, state: string, priority: number): Promise<PlanningResponse> {
  const pages: BandPage[] = [];
  for (let page = 0, count = 1; page < count; page += 1) {
    const r = await runBoardRequest(priority, () => authedFetch<BandPage>(`/delivery-planning?band=${band}&page=${page}${state === 'ALL' ? '' : `&state=${state}`}`));
    pages.push(r);
    count = r.band?.page_count ?? 0;
  }
  const d = sumDelivered(pages);
  const counts = { ...pages[0]!.counts };
  for (const p of pages.slice(1)) for (const [k, v] of Object.entries(p.counts)) counts[k as keyof PlanningCounts] += v;
  return { ...pages[0]!, orders: pages.flatMap((p) => p.orders), counts, ...(pages[0]!.delivered_by_region ? { delivered_by_region: d.byRegion } : {}) };
}

const rowKey = (o: PlanningOrder) => `${o.row_type}:${o.so_doc_no}`;

/** Band rows in load order, each row once. */
export function mergeBands(parts: ReadonlyArray<readonly PlanningOrder[]>): PlanningOrder[] {
  const seen = new Set<string>();
  const out: PlanningOrder[] = [];
  for (const rows of parts) for (const o of rows) if (!seen.has(rowKey(o))) { seen.add(rowKey(o)); out.push(o); }
  return out;
}

/** Delivered per region and in total, summed over the loaded OPEN bands (each counts its own). */
export function sumDelivered(parts: ReadonlyArray<PlanningResponse>): { total: number; byRegion: Record<string, number> } {
  const byRegion: Record<string, number> = {};
  let total = 0;
  for (const p of parts) {
    total += p.counts.DELIVERED;
    for (const [k, v] of Object.entries(p.delivered_by_region ?? {})) byRegion[k] = (byRegion[k] ?? 0) + v;
  }
  return { total, byRegion };
}

/** Every-region counts of the loaded board, as ?counts_only=1 counts them; null
    unless all five bands are in and none is being re-read. OPEN bands leave the
    Delivered rows out, so their own Delivered tallies are added back. */
export function loadedBoardCounts(qc: QueryClient, state: 'ALL' | 'OPEN'): PlanningCounts | null {
  const parts: PlanningResponse[] = [];
  for (const b of [1, 2, 3, 4, 5] as BandNo[]) {
    const q = qc.getQueryState<PlanningResponse>(['delivery-planning', 'ALL', state, 'band', b]);
    if (!q?.data || q.fetchStatus !== 'idle') return null;
    parts.push(q.data);
  }
  const c = planningCountsFrom(mergeBands(parts.map((p) => p.orders)));
  if (state === 'ALL') return c;
  const delivered = sumDelivered(parts).total;
  return { ...c, DELIVERED: delivered, ALL: c.ALL + delivered };
}

export type BandedBoard = {
  /** Rows loaded so far, band by band. */
  orders: PlanningOrder[];
  /** Each loaded band's response (for OPEN's delivered tallies). */
  parts: PlanningResponse[];
  regions: PlanningResponse['regions'] | undefined;
  /** The first band has not arrived yet. */
  firstLoading: boolean;
  /** The band being fetched now, or null. */
  loading: { band: BandNo; label: string } | null;
  /** The band that failed (the chain stops there) and how to try again. */
  failed: { band: BandNo; label: string; error: unknown; retry: () => void } | null;
  complete: boolean;
  /** When the newest loaded band arrived (ms), 0 before any. */
  updatedAt: number;
  refetch: () => void;
};

export function useBandedBoard(opts: { state: 'ALL' | 'OPEN'; first: BandNo }): BandedBoard {
  const order = useMemo(() => bandOrder(opts.first), [opts.first]);
  const keyOf = (b: BandNo) => ['delivery-planning', 'ALL', opts.state, 'band', b] as const;
  const results = useQueries({
    queries: order.map((b, i) => ({
      queryKey: keyOf(b),
      // All queued at once; runBoardRequest lets them through nearest first, two at a time.
      queryFn: () => fetchBand(b, opts.state, i + 1),
      staleTime: 30_000,
    })),
  });
  // The loaded prefix in load order: a band after a gap is not shown before the gap fills.
  const [d0, d1, d2, d3, d4] = results.map((r) => r.data);
  const parts = useMemo(() => {
    const out: PlanningResponse[] = [];
    for (const d of [d0, d1, d2, d3, d4]) { if (!d) break; out.push(d); }
    return out;
  }, [d0, d1, d2, d3, d4]);
  const orders = useMemo(() => mergeBands(parts.map((p) => p.orders)), [parts]);
  let loading: BandedBoard['loading'] = null;
  let failed: BandedBoard['failed'] = null;
  const next = parts.length;
  if (next < order.length) {
    const r = results[next]!; const band = order[next]!;
    if (r.isError) failed = { band, label: BAND_LABEL[band], error: r.error, retry: () => { void r.refetch(); } };
    else loading = { band, label: BAND_LABEL[band] };
  }
  return {
    orders,
    parts,
    regions: parts[0]?.regions,
    firstLoading: !results[0]?.data && !results[0]?.isError,
    loading,
    failed,
    complete: !loading && !failed,
    updatedAt: Math.max(0, ...results.map((r) => r.dataUpdatedAt)),
    refetch: () => { for (const r of results) void r.refetch(); },
  };
}

/** Tab counts for every region, before the rows: ?counts_only=1. */
export function useBoardCounts(enabled: boolean) {
  return useQuery({
    queryKey: ['delivery-planning', 'counts'],
    queryFn: () => runBoardRequest(COUNTS_PRIORITY, () => authedFetch<{ counts_by_region: Record<string, PlanningCounts> }>('/delivery-planning?counts_only=1')),
    enabled,
    staleTime: 30_000,
  });
}
