
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

const UNREADABLE_PREFIX = 'LINES_UNREADABLE: ';

export function unreadableMovementError(what: string, err: PgError): string {
  return `${UNREADABLE_PREFIX}could not read ${what} (${err?.message ?? 'unknown read error'}); no stock was moved.`;
}

export function hasUnreadableLines(errors: readonly string[]): boolean {
  return errors.some((e) => e.startsWith(UNREADABLE_PREFIX));
}

/** Thrown by a resolver deep under a stock write (a line's warehouse or batch)
 *  when its read failed. The writer catches it and refuses with nothing
 *  written; its message is an unreadableMovementError string. A reader with no
 *  writer above it (a detail page) lets it surface as a failed request rather
 *  than show a guessed warehouse. */
export class ReadFailedError extends Error {
  constructor(what: string, err: PgError) {
    super(unreadableMovementError(what, err));
    this.name = 'ReadFailedError';
  }
}
