
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
