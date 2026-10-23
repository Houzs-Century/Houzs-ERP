// ----------------------------------------------------------------------------
// do-status-counts — the DO list's filter-pill counts in ONE grouped read.
//
// HC-0002 (2026-10-23): the list paid nine `count:'exact', head:true` round
// trips per open (all + on_hold + one per DO_STATUS_BUCKETS entry). The buckets
// are pure status sets that partition scm.do_status, so one aggregate grouped by
// (status, on_hold) answers every pill: `all` is the sum of the groups, a bucket
// is the sum of its member statuses, `on_hold` the sum of the held groups. Same
// pattern as the SO list's `status, cnt:doc_no.count()` read (mfg-sales-orders.ts).
//
// If the aggregate read fails, the nine counts it replaced run instead, so a
// PostgREST without aggregates still answers exactly as before.
// ----------------------------------------------------------------------------

import { DO_STATUS_BUCKETS } from './do-status-buckets';
import { readStatusCounts, type CountQueryResult, type StatusCountsRead } from './status-counts';

type Grouped = { status: string | null; on_hold: boolean | null; cnt: number | string | null };
type Filterable = PromiseLike<CountQueryResult> & { eq(col: string, v: unknown): Filterable; in(col: string, v: unknown[]): Filterable };

/** `base(select, opts)` is the list's count scope (company + sales scope + date window) over delivery_orders. */
export async function doListStatusCounts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the aggregate select defeats supabase-js's column-type inference (same as the SO list's grouped count)
  base: (select: string, opts?: { count: 'exact'; head: true }) => any,
): Promise<StatusCountsRead<string>> {
  const bucketNames = Object.keys(DO_STATUS_BUCKETS);
  const agg = (await base('status, on_hold, cnt:id.count()')) as { data: Grouped[] | null; error: { message?: string | null } | null };
  if (!agg.error && agg.data) {
    let all = 0;
    let held = 0;
    const byStatus = new Map<string, number>();
    for (const g of agg.data) {
      const n = Number(g.cnt ?? 0);
      all += n;
      if (g.on_hold === true) held += n;
      const key = String(g.status ?? '');
      byStatus.set(key, (byStatus.get(key) ?? 0) + n);
    }
    const counts: Record<string, number> = { all, on_hold: held };
    for (const b of bucketNames) counts[b] = DO_STATUS_BUCKETS[b]!.reduce((s, st) => s + (byStatus.get(st) ?? 0), 0);
    return { ok: true, counts };
  }

  const head = () => base('*', { count: 'exact', head: true }) as Filterable;
  /* `on_hold` is NOT in DO_STATUS_BUCKETS and must not be — that map is an
     exhaustive partition of scm.do_status (statusBucketsEnumMembership.test.mjs)
     and this is a column. Counted here as an OVERLAY: a held DO is counted
     under its real status too, so these do not sum to `all`. */
  const [allC, heldC, ...bucketC] = await Promise.all([
    head(),
    head().eq('on_hold', true), // marker only — see the tab filter in lib/do-list-read.ts
    ...bucketNames.map((b) => head().in('status', DO_STATUS_BUCKETS[b]!)),
  ]);
  // A count that could not be READ is reported, never served as 0; an empty bucket still answers 0 (lib/status-counts.ts).
  return readStatusCounts(Object.fromEntries([
    ['all', allC], ['on_hold', heldC], ...bucketNames.map((b, i) => [b, bucketC[i]!]),
  ]) as Record<string, CountQueryResult>);
}
