// ----------------------------------------------------------------------------
// line-write-failures — what a Sales Order line write says when it does NOT
// land, for BOTH surfaces.
//
// WHY THIS EXISTS. The owner, on a phone, changed the fabric colour on an
// imported Sales Order and pressed Save. He was told:
//
//   "2 line change(s) did not save. Your edits are still here; try Save again."
//
// He tried again, repeatedly, and it could never have worked. The order is
// AutoCount-imported and the migrated-SO lock (backend/src/scm/lib/
// migrated-so-readonly.ts) was refusing every line write with a 409 that
// carried its OWN operator sentence — "This order came from AutoCount and is
// view-only for now…". MobileNewSO.applyLineDiff caught each call with a bare
// `catch { failed += 1; }`, so the server's explanation was discarded at the
// moment it arrived and the caller rebuilt a sentence out of the count alone.
//
// That is CLAUDE.md's named bug class ("a failure that reaches nobody is worse
// than a crash") wearing a different hat: the failure DID reach somebody, and
// arrived stripped of the only part that was actionable. A count cannot tell a
// lock apart from a network blip, so the advice attached to it was wrong for
// half the causes it covered — and "try Save again" is the exact wrong advice
// for a refusal, because retrying is what the operator had already been doing.
//
// THREE RULES, and they are the whole module:
//
//   1. CARRY THE REASON. authedFetch already humanises an API error to one
//      plain sentence and stashes the HTTP status on the Error
//      (vendor/scm/lib/authed-fetch.ts). Both are captured per failed call.
//      There is no second error vocabulary here.
//   2. ONE SHARED CAUSE IS SAID ONCE. Three lines refused by one lock is one
//      fact, not three; repeating it buries it. The count survives, because
//      the count is what tells the operator how much did not go out.
//   3. RETRY ADVICE IS EARNED, NOT DEFAULT. A 403/409-class refusal is a
//      DECISION about this document and pressing Save again cannot change it.
//      A conflict, a timeout or a 5xx is a hiccup and retrying is exactly
//      right. The status decides which sentence is attached.
//
// PURE ON PURPOSE — no React, no fetch — so both surfaces can share it and it
// is testable without mounting a 3,700-line screen. Desktop reaches it through
// pages/scm-v2/so-add-lines.ts, which already owned this vocabulary and now
// backs onto it rather than keeping a second copy.
// ----------------------------------------------------------------------------

/** One line write that did not land. `status` is absent when the rejection
 *  never carried one — a network failure, an abort, a thrown TypeError. That
 *  ABSENCE is meaningful and is why the field is optional rather than a 0:
 *  "no status" is a hiccup, and a hiccup is retryable. */
export type LineWriteFailure = { label: string; message: string; status?: number };

/** Last-resort wording. Reached only when the rejection is not an Error, or is
 *  an Error with an empty message — authedFetch never produces either. */
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

/**
 * Statuses that mean the server DECIDED, rather than the server stumbled.
 *
 * 409 is the migrated-SO lock, the write freeze, the downstream lock and the
 * version conflict; 403 is a permission refusal. Pressing Save again changes
 * none of them, so none of them may carry retry advice.
 *
 * A version conflict is the one 409 a retry could in principle clear — but only
 * after the operator reloads, which "try Save again" does not tell them to do.
 * Sending them to reload-and-check rather than to a button that will refuse
 * again is the better of the two wrong-ish answers, and the desktop screen
 * already handles that case separately with its own banner.
 */
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

/** What a retryable failure promises: the work is still on screen. */
const RETRY_TAIL = 'Your edits are still here; try Save again.';

/** What a refusal promises instead — the same reassurance about the work,
 *  and NO instruction to do the thing that has already failed. */
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
