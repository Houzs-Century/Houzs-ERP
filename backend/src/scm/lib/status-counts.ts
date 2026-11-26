
/** The shape of an awaited supabase-js `count:'exact', head:true` query. Kept
 *  structural (and every field optional) because the SCM client is `any` at the
 *  call sites — this must accept what those awaits actually produce, not what a
 *  typed client would promise. */
export type CountQueryResult = {
  count?: number | null;
  error?: { message?: string | null } | null;
};

export type StatusCountsRead<K extends string> =
  | { ok: true; counts: Record<K, number> }
  | { ok: false; reason: string };

/**
 * Turn a bucket-name → count-query-result map into the counts to serve, or the
 * reason the counts cannot be trusted.
 *
 * Reports the FIRST failing bucket by name, in the map's own key order, so the
 * message says which count broke rather than only that something did.
 */
export function readStatusCounts<K extends string>(
  results: Record<K, CountQueryResult>,
): StatusCountsRead<K> {
  const counts = {} as Record<K, number>;
  for (const key of Object.keys(results) as K[]) {
    const res = results[key];
    const err = res.error;
    if (err) {
      return { ok: false, reason: `${key} count failed: ${err.message || 'unknown error'}` };
    }
    const n = res.count;
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      return { ok: false, reason: `${key} count returned no value` };
    }
    counts[key] = n;
  }
  return { ok: true, counts };
}


export type StatusTally =
  | { ok: true; byStatus: Record<string, number> }
  | { ok: false; reason: string };

/**
 * Tally a read of a status column into `RAW_STATUS -> count`, or say the read
 * FAILED. A blank/absent status tallies under `UNKNOWN` rather than vanishing.
 *
 * `weight` is REQUIRED, not defaulted to 1: one caller reads raw rows (weight 1
 * each) and the other reads a grouped aggregate whose weight is the group's own
 * count, and silently getting that wrong would produce a plausible number.
 */
export function tallyStatusRows<T extends { status?: string | null }>(
  res: { data: T[] | null | undefined; error?: { message?: string | null } | null },
  weight: (row: T) => number,
): StatusTally {
  if (res.error) return { ok: false, reason: res.error.message || 'unknown error' };
  if (res.data === null || res.data === undefined) {
    return { ok: false, reason: 'status rows returned no value' };
  }
  const byStatus: Record<string, number> = {};
  for (const row of res.data) {
    const key = String(row.status ?? '').toUpperCase() || 'UNKNOWN';
    byStatus[key] = (byStatus[key] ?? 0) + weight(row);
  }
  return { ok: true, byStatus };
}
