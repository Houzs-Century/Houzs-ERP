/* Which board rows a GET /delivery-planning answers with, by `state`.
   OPEN = every row but Delivered (2026-10-26: Delivered was 72% of a 5.4 MB
   payload re-downloaded on every edit). The board fetches OPEN for its working
   tabs; Delivered counts per region ride along so the tab badges stay right
   without the rows. ALL and a single state behave as before. */
export function boardSlice<T extends { delivery_state: string; regions: readonly string[] }>(
  rows: T[],
  stateParam: string,
): { orders: T[]; deliveredByRegion: Record<string, number> | null } {
  if (stateParam === 'ALL') return { orders: rows, deliveredByRegion: null };
  if (stateParam !== 'OPEN') return { orders: rows.filter((o) => o.delivery_state === stateParam), deliveredByRegion: null };
  const deliveredByRegion: Record<string, number> = {};
  const orders: T[] = [];
  for (const o of rows) {
    if (o.delivery_state !== 'DELIVERED') { orders.push(o); continue; }
    for (const r of o.regions) deliveredByRegion[r] = (deliveredByRegion[r] ?? 0) + 1;
  }
  return { orders, deliveredByRegion };
}

/** For state=OPEN, set the status-DELIVERED orders aside before the per-order
 *  reads (lines, deliverable sums, DOs, balances, PO numbers): their board state
 *  is DELIVERED no matter what those reads say (derivePlanningState), so the
 *  board only needs to count them. */
export function splitDeliveredForOpen<T extends { status: string | null }>(rows: T[], open: boolean): { kept: T[]; skipped: T[] } {
  if (!open) return { kept: rows, skipped: [] };
  const kept: T[] = []; const skipped: T[] = [];
  for (const r of rows) (String(r.status ?? '').toUpperCase() === 'DELIVERED' ? skipped : kept).push(r);
  return { kept, skipped };
}

/** Fold the set-aside Delivered orders into the badges: the region-scoped
 *  counts and the per-region Delivered tally. */
export function addSkippedDelivered<T>(
  skipped: T[],
  regionsOf: (r: T) => readonly string[],
  regionParam: string,
  counts: Record<string, number>,
  deliveredByRegion: Record<string, number> | null,
): void {
  for (const r of skipped) {
    const regions = regionsOf(r);
    if (deliveredByRegion) for (const g of regions) deliveredByRegion[g] = (deliveredByRegion[g] ?? 0) + 1;
    if (regionParam === 'ALL' || regionParam === '' || regions.includes(regionParam)) {
      counts.DELIVERED = (counts.DELIVERED ?? 0) + 1;
      counts.ALL = (counts.ALL ?? 0) + 1;
    }
  }
}

/** ?docs=A,B,... -> the SO doc numbers a row refresh rebuilds (at most 100,
 *  trimmed, de-duplicated); null when the parameter is absent = the whole board. */
export function parseOnlyDocs(raw: string | undefined): string[] | null {
  if (raw == null) return null;
  return [...new Set(raw.split(',').map((d) => d.trim()).filter(Boolean))].slice(0, 100);
}

/** Narrow the SO header read to the row-refresh docs; the whole board otherwise. */
export function onlyDocsFilter<Q extends { in: (col: string, values: string[]) => Q }>(q: Q, onlyDocs: string[] | null): Q {
  return onlyDocs ? q.in('doc_no', onlyDocs) : q;
}
