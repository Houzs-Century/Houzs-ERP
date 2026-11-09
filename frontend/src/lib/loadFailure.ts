/* "Not found" is a claim about the record; a timeout or a 500 is a claim about
   the request. Detail pages used to show "X not found" for both, so an operator
   on a bad connection re-keyed an order that already existed (a duplicate), and
   the warehouse DO scan told staff to re-print a perfectly good DO. Only a real
   404, or a successful answer with no record in it, is "not found"; anything
   else is "could not load" with the reason and a Retry. */

/** Both error shapes in this app carry a numeric `.status` (see lib/retryPolicy.ts). */
export function isNotFoundError(error: unknown): boolean {
  return (error as { status?: unknown } | null | undefined)?.status === 404;
}

export type LoadFailure =
  | { kind: 'not-found'; reason: string | null }
  | { kind: 'load-failed'; reason: string };

/**
 * Classify a detail query that has no record to show. `error` is the query's
 * error, or null when the request succeeded but returned no record.
 */
export function classifyLoadFailure(error: unknown): LoadFailure {
  if (error == null) return { kind: 'not-found', reason: null };
  const message = error instanceof Error && error.message ? error.message : null;
  if (isNotFoundError(error)) return { kind: 'not-found', reason: message };
  return { kind: 'load-failed', reason: message ?? 'The request did not finish.' };
}
