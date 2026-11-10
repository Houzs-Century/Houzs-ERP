/* A read that FAILED is not a read that found nothing.
 *
 * supabase-js does not throw: a failed query resolves to `{ data: null, error }`.
 * Code that destructures only `data` then treats `null` as "this document has no
 * lines", and the write right after it goes ahead on that empty picture: a GRN
 * flips to POSTED with no stock IN, a DO ships and reports "no stock errors", a
 * resync sees no lines and reverses the whole shipment. The document then SAYS
 * done while the ledger says otherwise, which is the one outcome the owner
 * fears most.
 *
 * The rule these helpers carry: when a read in front of a stock, money or status
 * write fails, refuse and write nothing, and tell the operator it is safe to
 * try again. Never guess. */

export const LINES_UNREADABLE = 'lines_unreadable' as const;

type PgError = { message?: string | null } | null | undefined;

/** The operator-facing sentence. `what` names the thing that could not be read
 *  ("the receipt lines"), `verb` what did not happen ("posted", "shipped"). */
export function linesUnreadableMessage(what: string, verb: string): string {
  return `Could not read ${what}, so nothing was ${verb}. Please try again.`;
}

/** The JSON body for a refused post/ship. 503: the request was fine, the read
 *  was not, and the same request may succeed on retry. */
export function linesUnreadableBody(what: string, verb: string, err: PgError) {
  return {
    error: LINES_UNREADABLE,
    message: linesUnreadableMessage(what, verb),
    reason: err?.message ?? 'unknown read error',
  };
}

/* A movement-error string that marks "nothing was written because the lines
   could not be read". The DO and purchase-return stock writers report through a
   string[] (their callers already surface it as movementErrors); the prefix lets
   a caller that must undo its own status flip tell this case apart from a
   failed movement write, without changing every caller's return type. */
const UNREADABLE_PREFIX = 'LINES_UNREADABLE: ';

export function unreadableMovementError(what: string, err: PgError): string {
  return `${UNREADABLE_PREFIX}could not read ${what} (${err?.message ?? 'unknown read error'}); no stock was moved.`;
}

export function hasUnreadableLines(errors: readonly string[]): boolean {
  return errors.some((e) => e.startsWith(UNREADABLE_PREFIX));
}
