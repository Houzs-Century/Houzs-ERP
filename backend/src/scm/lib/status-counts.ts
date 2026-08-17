/* ----------------------------------------------------------------------------
   status-counts — read the filter-pill counts, or say the read FAILED.

   WHY THIS FILE EXISTS. Five list endpoints (PO, PI, SI, GRN, DO) compute their
   tab counts the same way: a `Promise.all` of `count:'exact', head:true`
   queries, one per bucket, then `result.count ?? 0` into the response. That
   `?? 0` is the bug. A count query that FAILED also has a null count, so a
   broken bucket rendered as an EMPTY bucket — a zero on the tab, no error in
   the response, nothing in the log, and rows the operator can reach from no tab
   at all.

   It is not hypothetical. Measured against production on 2026-08-17: the DO
   list answered company 1 `all:27 delivered:0` and company 2 `all:36
   delivered:0` while the delivered count query was failing on a non-enum label
   in its bucket (DO_STATUS_BUCKETS carried 'COMPLETED'). 37 delivery orders
   across the two companies were invisible and the numbers looked settled. The
   bucket bug is fixed; this exists so the NEXT one is loud on the first request
   instead of silently subtracting rows from what the operator is counting.

   A LEGITIMATELY EMPTY BUCKET IS NOT AN ERROR. PostgREST answers an empty
   `count:'exact'` query with the number 0 and no error, which is a fact and
   passes through as 0. What is refused is the absence of an answer: an `error`,
   or a count that is not a number (supabase-js leaves `count` null when the
   Content-Range header it parses is missing, so "the server never told us" and
   "the server said none" are two different states that `?? 0` collapsed into
   one).

   The caller decides what to do with a failure; every current call site turns it
   into a 500 beside the list read's own failure path, because a list whose tab
   counts are wrong is a list that misinforms the person reading it.
   ---------------------------------------------------------------------------- */

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
      // No error, but no number either — the count header never arrived. Zero
      // would be a claim we cannot support; say so instead.
      return { ok: false, reason: `${key} count returned no value` };
    }
    counts[key] = n;
  }
  return { ok: true, counts };
}
