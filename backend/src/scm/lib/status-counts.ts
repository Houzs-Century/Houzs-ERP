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

/* ---------------------------------------------------------------------------
   The OTHER shape of the same bug, and the one that survived the first sweep.

   Two consumers do not run one query per bucket — they read the status COLUMN
   (or a grouped aggregate over it) and tally in JS: the SO list's filter pills
   (mfg-sales-orders.ts) and the Delivery Agent's DO pipeline
   (services/agents/delivery-agent.ts). Both wrote `for (const r of (res.data ??
   []))`, and `data ?? []` is `count ?? 0` wearing a different hat: PostgREST
   and paginateAll both answer a FAILED read with `{ data: null, error }`, so a
   failure tallied as ZERO ROWS. The SO list served every pill as 0 beside a
   full page of orders; the agent's pipeline reported the failed bucket as
   simply absent, then handed that to the brain as fact.

   Reading the column instead of enumerating a vocabulary also fixes the other
   half: nothing is handed to Postgres to parse, so a label that is not an enum
   member — 'COMPLETED' on do_status — cannot 22P02 the query in the first place.
   --------------------------------------------------------------------------- */

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
/* `data` is `T[] | null | undefined` on PURPOSE. Every call site reads through
   an `sb: any` client, so "no data property at all" is a state that reaches
   here, and the undefined arm of the guard below is what answers it. It was
   typed `T[] | null` until 2026-08-18, which made no-unnecessary-condition
   correct about the arm being dead — measured by deleting it: tsc then reports
   `TS18048: 'res.data' is possibly 'undefined'` on the loop below, and the
   'an ABSENT data property' test fails with `TypeError: res.data is not
   iterable`. The repair for that warning was the honest type, not the shorter
   guard. */
export function tallyStatusRows<T extends { status?: string | null }>(
  res: { data: T[] | null | undefined; error?: { message?: string | null } | null },
  weight: (row: T) => number,
): StatusTally {
  if (res.error) return { ok: false, reason: res.error.message || 'unknown error' };
  if (res.data === null || res.data === undefined) {
    // No error, no rows object: the read produced no answer, and an empty tally
    // would be a claim we cannot support.
    return { ok: false, reason: 'status rows returned no value' };
  }
  const byStatus: Record<string, number> = {};
  for (const row of res.data) {
    const key = String(row.status ?? '').toUpperCase() || 'UNKNOWN';
    byStatus[key] = (byStatus[key] ?? 0) + weight(row);
  }
  return { ok: true, byStatus };
}
