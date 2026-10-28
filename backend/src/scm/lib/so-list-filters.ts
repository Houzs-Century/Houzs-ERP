// Filter/paging helpers for the Sales Orders list (GET /api/scm/mfg-sales-orders).
//
// Both bugs here produced the SAME production symptom on 2026-08-18: the SO list
// showing "No sales orders yet" for a company that has 2,726 orders, while the
// network layer carried a 500 { error: 'load_failed', reason: 'Requested range
// not satisfiable' } that the grid swallowed (a C15-class masking).

/**
 * The effective `status` filter for a list request, or `undefined` for "no
 * status filter".
 *
 * `all` / `ALL` / `''` mean the **All** tab — every status. The list handler
 * used to apply the raw param directly as `q.eq('status', status)`, so
 * `?status=all` filtered to rows whose status is literally the string `'all'`.
 * No sales order carries that status (the real values are CONFIRMED /
 * READY_TO_SHIP / DELIVERED / CANCELLED / DRAFT / …), so the query matched ZERO
 * rows; with `count:'exact'` a page past offset 0 then exceeds the count and
 * PostgREST answers 416 → the handler returned 500.
 *
 * The frontend list hooks omit the param for the All tab, but a bookmarked or
 * shared URL, the Mail Center views, and any other caller send `?status=all`
 * literally — so the normalisation belongs on the SERVER, once, for every path.
 *
 * `OTHER` (rows outside the known vocabulary) and every real status pass through
 * unchanged.
 */
export function effectiveStatusFilter(raw: string | undefined | null): string | undefined {
  if (raw == null) return undefined;
  const t = raw.trim();
  if (t === "" || t.toLowerCase() === "all") return undefined;
  return t;
}

/**
 * True when a PostgREST error is the "requested range is at or beyond the row
 * count" answer (PGRST103 / HTTP 416, message "Requested range not
 * satisfiable").
 *
 * This is NOT a failure — it is how PostgREST reports "you asked for a page past
 * the end". It happens for any legitimately empty result set once you page past
 * offset 0: an empty status tab, a search with no matches, or the last page + 1.
 * The list handler treated it as a 500, which the grid rendered as "No sales
 * orders yet". Callers use this to return an EMPTY PAGE (200) with the true
 * count instead — the count rides the `Content-Range: * / N` header that
 * PostgREST returns even on a 416, so `res.count` is still populated.
 */
export function isRangeNotSatisfiable(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false;
  if (error.code === "PGRST103") return true;
  return typeof error.message === "string" && /range not satisfiable/i.test(error.message);
}
