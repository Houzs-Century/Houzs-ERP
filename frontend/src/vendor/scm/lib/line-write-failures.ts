
/** One line write that did not land. `status` is absent when the rejection
 *  never carried one — a network failure, an abort, a thrown TypeError. That
 *  ABSENCE is meaningful and is why the field is optional rather than a 0:
 *  "no status" is a hiccup, and a hiccup is retryable. */
export type LineWriteFailure = { label: string; message: string; status?: number };

const GENERIC = 'Something went wrong.';

/**
 * Capture a rejected line write with everything the operator can act on.
 *
 * `label` is what they will look at on screen: the item code, or a staged
 * line's position. The MESSAGE is the server's own sentence, already made plain
 * by humanApiError; the STATUS is the raw code, kept for the retry decision and
 * never shown (CLAUDE.md: no HTTP codes in operator text).
 */
export function lineWriteFailure(label: string, e: unknown): LineWriteFailure {
  const err = e as (Error & { status?: unknown }) | null | undefined;
  const status = typeof err?.status === 'number' ? err.status : undefined;
  return {
    label,
    message: e instanceof Error && e.message ? e.message : GENERIC,
    ...(status === undefined ? {} : { status }),
  };
}

/**
 * The one cause every failure shares, or null when they differ.
 *
 * TWO OR MORE, deliberately. A single failure has nothing to collapse, and
 * collapsing it would throw away the line's label — the half that says WHICH
 * row to go and look at.
 */
export function sharedFailureCause(failures: readonly LineWriteFailure[]): string | null {
  if (failures.length < 2) return null;
  const first = failures[0]!.message;
  return failures.every((f) => f.message === first) ? first : null;
}

const REFUSAL_STATUSES: ReadonlySet<number> = new Set([403, 409]);

/**
 * True when EVERY failure is a refusal. Mixed causes fall to false on purpose:
 * if one line hit a lock and another hit a timeout, some of the work genuinely
 * is retryable and telling the operator otherwise loses it.
 */
export function isRefusal(failures: readonly LineWriteFailure[]): boolean {
  return failures.length > 0
    && failures.every((f) => f.status !== undefined && REFUSAL_STATUSES.has(f.status));
}

/**
 * Name what failed: the shared cause once, or every line's own reason.
 *
 * The count leads whenever there is more than one, because "how much did not
 * save" is the first thing the operator needs and the last thing a list of
 * reasons makes obvious.
 */
export function namedFailures(failures: readonly LineWriteFailure[]): string {
  if (failures.length === 0) return '';
  if (failures.length === 1) {
    const only = failures[0]!;
    return `Could not save ${only.label}: ${only.message}`;
  }
  const shared = sharedFailureCause(failures);
  const detail = shared ?? failures.map((f) => `${f.label}: ${f.message}`).join(' · ');
  return `${failures.length} lines could not be saved — ${detail}`;
}

const RETRY_TAIL = 'Your edits are still here; try Save again.';

const REFUSED_TAIL =
  'Your edits are still on screen. Saving again will not help until this is resolved.';

/**
 * The sentence a Sales Order save shows when its line writes did not land.
 *
 * Used by the mobile editor, which has no per-line banner to hang a reason on
 * and therefore has to say everything in one string. Desktop composes its own
 * tail (it also has staged adds to account for) from `namedFailures`.
 */
export function lineWriteSaveMessage(failures: readonly LineWriteFailure[]): string {
  if (failures.length === 0) return '';
  return `${namedFailures(failures)}. ${isRefusal(failures) ? REFUSED_TAIL : RETRY_TAIL}`;
}
