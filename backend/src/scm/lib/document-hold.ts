/* ----------------------------------------------------------------------------
   document-hold — a HOLD is a MARKER on a document, not a step in its life.

   THE OWNER, 2026-08-22: 「我们的hold是给我们知道一个 order hold这的」 — the hold
   exists so people KNOW an order is paused. And 「take off hold也要看」 —
   releasing had to be looked at too.

   WHAT IT REPLACES, and why it is a defect and not a preference. The hold used
   to be WRITTEN INTO the `status` column. That column is the only place a
   document's progress lives, so:

     · holding an IN_PRODUCTION sales order DESTROYED the fact that it was in
       production — there is no `previous_status` column anywhere in scm, which
       `grep -rn "previous_status\|status_before\|held_from" backend/src/scm/`
       confirms by returning nothing;
     · `Take Off Hold` wrote CONFIRMED unconditionally, so every released order
       landed on Confirmed no matter where it had actually been;
     · ON_HOLD had to be left UNRANKED in the sales order's transition table,
       which turned it into a laundry — DELIVERED is refused a move to DRAFT on
       rank, but DELIVERED -> ON_HOLD -> DRAFT passed both halves (the note in
       so-lifecycle-guards.ts, which had to special-case ON_HOLD -> DRAFT to
       close it).

   A marker has none of those problems. The status is never touched, so taking
   the hold off restores nothing — there is nothing to restore, the order never
   left. That is the entire idea.

   TWO READERS, AND BOTH ARE NEEDED FOR EVER. `ON_HOLD` stays a legal label in
   scm.po_status, scm.grn_status, scm.purchase_invoice_status and
   scm.mfg_so_status permanently, because Postgres has no DROP VALUE. Nothing in
   this system writes it any more, but a row can still arrive carrying it — from
   the AutoCount mirror, from an older client, from a document written before
   mig 0324. So `isDocumentHeld` reads the FLAG *or* the legacy label, and every
   pill map keeps its ON_HOLD entry.

   MEASURED, NOT ASSUMED: production carried ZERO rows on ON_HOLD when the flag
   was introduced — workflow run 32573160010, 2026-08-22, all five tables. The
   legacy arm is therefore dead code TODAY and kept anyway, because "no row has
   it" is a fact about one moment and the enum label is permanent.
   ---------------------------------------------------------------------------- */

/** The legacy status label. Never written; still read. */
export const LEGACY_HOLD_STATUS = 'ON_HOLD';

/** The four columns mig 0324 put on each of the five document tables. Selecting
 *  them by this constant is what stops a route reading the flag from a row it
 *  never asked for it on — `undefined` is not `false`, and a guard that reads an
 *  unselected column silently answers "not held" for everything. */
export const HOLD_COLUMNS = 'on_hold, hold_reason, held_at, held_by';

export type HoldableRow = {
  status?: string | null;
  on_hold?: boolean | null;
};

/**
 * Is this document held?
 *
 * TRUE when the marker is on it, OR when its status still carries the legacy
 * `ON_HOLD` label. The second arm is what keeps a pre-0324 row — or a mirrored
 * one — behaving exactly as it did before the flag existed.
 *
 * The caller MUST have selected `on_hold`. A row that never fetched the column
 * reads `undefined`, which is not held, which is the permissive answer — so use
 * `HOLD_COLUMNS` in the select rather than trusting the shape.
 */
export function isDocumentHeld(row: HoldableRow | null | undefined): boolean {
  if (!row) return false;
  if (row.on_hold === true) return true;
  return String(row.status ?? '').toUpperCase() === LEGACY_HOLD_STATUS;
}

/**
 * Narrow a PostgREST query to the documents that are NOT held.
 *
 * Both halves are applied, and both are load-bearing: `on_hold = false` covers
 * every document held the new way, and the status predicate covers a legacy row.
 * Existing callers already carried a `.not('status','in','(...,"ON_HOLD")')`
 * term; this adds the flag half beside it rather than replacing it.
 */
export function excludeHeld<Q extends { eq: (col: string, val: unknown) => Q }>(query: Q): Q {
  return query.eq('on_hold', false);
}

/**
 * The PostgREST `or` term that selects the HELD documents — the "On Hold" tab.
 *
 * `on_hold.is.true,status.eq.ON_HOLD` reads as "the marker is on it, or it is a
 * legacy row that still says so". Passed to `.or(...)`, which is an OR across
 * the whole filter group, so it must be the only membership term in that group.
 */
export const HELD_OR_TERM = `on_hold.is.true,status.eq.${LEGACY_HOLD_STATUS}`;

/** What a caller sends to put a marker on or take it off. */
export type HoldRequest = { onHold: boolean; reason: string | null };

/**
 * Read a hold request out of a request body.
 *
 * `onHold` is REQUIRED and has no default. This is the repo's standing rule
 * about a parameter that DECIDES something: a missing `onHold` that defaulted to
 * `true` would turn a malformed release into a hold, silently, and a default of
 * `false` would turn a malformed hold into a release. Neither is a safe guess,
 * so there is no guess.
 */
export function readHoldRequest(body: unknown): HoldRequest | { error: string; reason: string } {
  const b = (body ?? {}) as { onHold?: unknown; on_hold?: unknown; reason?: unknown };
  const raw = b.onHold ?? b.on_hold;
  if (typeof raw !== 'boolean') {
    return {
      error: 'on_hold_required',
      reason: 'Say whether this document is going on hold or coming off it.',
    };
  }
  const reasonRaw = typeof b.reason === 'string' ? b.reason.trim() : '';
  return { onHold: raw, reason: reasonRaw === '' ? null : reasonRaw.slice(0, 500) };
}

/**
 * The columns to write for a hold or a release.
 *
 * A RELEASE CLEARS THE WHOLE MARKER, including who and when. The document's own
 * audit log is where the history of holds belongs; leaving `held_at` populated
 * on a released document would make every "is it held" read that forgets to
 * check `on_hold` answer yes, which is the exact class of bug this change is
 * fixing. The status column is ABSENT from both shapes on purpose — that is the
 * whole point, and it is the one property worth checking in review.
 */
export function holdPatch(req: HoldRequest, actorId: string | null): Record<string, unknown> {
  return req.onHold
    ? { on_hold: true, hold_reason: req.reason, held_at: new Date().toISOString(), held_by: actorId }
    : { on_hold: false, hold_reason: null, held_at: null, held_by: null };
}

/** A refusal for an action that a held document must not accept. */
export function heldRefusal(documentLabel: string, action: string): { error: string; reason: string } {
  return {
    error: 'document_on_hold',
    reason: `This ${documentLabel} is on hold. Take it off hold before you ${action}.`,
  };
}
