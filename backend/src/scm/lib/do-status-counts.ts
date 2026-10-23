// ----------------------------------------------------------------------------
// do-status-counts — the DO list's filter-pill counts in ONE grouped read.
//
// HC-0002 (2026-10-23): the list paid nine `count:'exact', head:true` round
// trips per open (all + on_hold + one per DO_STATUS_BUCKETS entry). The buckets
// are pure status sets that partition scm.do_status, so one read grouped by
// (status, on_hold) answers every pill: `all` is the sum of the groups, a bucket
// is the sum of its member statuses, `on_hold` the sum of the held groups. Same
// pattern as the SO list's `status, cnt:doc_no.count()` read (mfg-sales-orders.ts).
//
// The grouping is an aggregate when PostgREST allows one (lib/postgrest-aggregate.ts).
// Prod answers PGRST123 (aggregates off), so the steady state there is the
// fallback: the (status, on_hold) columns of the same scoped rows, paged in id
// order and grouped here — one round trip per 1000 delivery orders in scope.
// ----------------------------------------------------------------------------

import { DO_STATUS_BUCKETS } from './do-status-buckets';
import { paginateAll } from './paginate-all';
import { readAggregate } from './postgrest-aggregate';
import type { StatusCountsRead } from './status-counts';

type Grouped = { status: string | null; on_hold: boolean | null; cnt?: number | string | null };
type ReadError = { code?: string | null; message?: string | null } | null;

function countsFrom(groups: Grouped[]): Record<string, number> {
  let all = 0;
  let held = 0;
  const byStatus = new Map<string, number>();
  for (const g of groups) {
    const n = g.cnt === undefined ? 1 : Number(g.cnt ?? 0);
    all += n;
    if (g.on_hold === true) held += n;
    const key = String(g.status ?? '');
    byStatus.set(key, (byStatus.get(key) ?? 0) + n);
  }
  const counts: Record<string, number> = { all, on_hold: held };
  for (const [b, members] of Object.entries(DO_STATUS_BUCKETS)) {
    counts[b] = members.reduce((s, st) => s + (byStatus.get(st) ?? 0), 0);
  }
  return counts;
}

/** `base(select)` is the list's count scope (company + sales scope + date window) over delivery_orders. */
export async function doListStatusCounts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the aggregate select defeats supabase-js's column-type inference (same as the SO list's grouped count)
  base: (select: string) => any,
): Promise<StatusCountsRead<string>> {
  const agg = await readAggregate(() => base('status, on_hold, cnt:id.count()') as PromiseLike<{ data: Grouped[] | null; error: ReadError }>);
  if (!agg.error && agg.data) return { ok: true, counts: countsFrom(agg.data) };

  /* Ordered: unordered `.range()` pages can repeat and skip rows (lib/paginate-all.ts). */
  const rows = await paginateAll<Grouped>((from, to) => base('status, on_hold').order('id', { ascending: true }).range(from, to));
  /* A count that could not be READ is reported, never served as 0 (lib/status-counts.ts). */
  if (rows.error || !rows.data) {
    return { ok: false, reason: `status counts failed: aggregate ${agg.error?.message ?? 'no value'}; fallback ${rows.error?.message ?? 'no value'}` };
  }
  return { ok: true, counts: countsFrom(rows.data) };
}
