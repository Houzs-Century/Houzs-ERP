/* ---------------------------------------------------------------------------
   so-edit-lease — how long a sales order's save lock lives, and what to SAY
   when a save runs into one.
   ---------------------------------------------------------------------------
   THE LOCK COVERS ONE SAVE, NOT AN EDITING SESSION. `runSoVersionedMutation`
   (frontend/src/vendor/scm/lib/so-versioned-mutation.ts) reserves the lease,
   performs the action, and releases it in a `finally`. Opening an order takes
   no lock at all. So the only thing the expiry has to outlast is one save
   round-trip — seconds — and everything above that is time a document spends
   locked for nothing after a save dies without releasing.

   IT WAS FIVE MINUTES, and the owner is the one who found what that costs:

     「我现在一个人只能 edit 一次，不可以呀。我一 save 了，我一 edit，关了就是关了？」

   He was working alone. A save had timed out (a 504 in his console), its lease
   was left behind, and every retry for the next five minutes came back saying
   the order was being saved on another screen. There was no other screen.

   WHAT THE LOCK STILL DOES, so nobody shortens it to nothing later: it stops
   two people's composite saves interleaving — reserve, line writes, header
   commit are separate requests, and version CAS alone cannot see a half-applied
   set of line writes. One minute covers a save with room to spare and bounds a
   crashed one to something a person will wait through.

   NOT A LIVENESS CHECK, and that is still the honest limit: nothing confirms
   the other screen is alive. A lock left by a dead tab looks exactly like one a
   live tab holds. What mig 0348 adds is the HOLDER, which settles the case that
   actually hurt — your own crashed save — because the same person takes their
   own lock back instead of waiting it out. A lock held by SOMEBODY ELSE is
   still only a timestamp, and one minute is the whole of that guarantee.
   -------------------------------------------------------------------------- */

/** One minute. See the header for why this is not five. */
export const SO_EDIT_LEASE_MS = 60_000;

export const soEditLeaseExpiryIso = (now: number = Date.now()): string =>
  new Date(now + SO_EDIT_LEASE_MS).toISOString();

/**
 * WHY a save was refused, at the granularity the server can actually prove.
 *
 * `held` deliberately does NOT say "another screen". The row records a token
 * and an expiry and nothing else, so a lock left behind by the caller's own
 * crashed save is indistinguishable from a colleague's live one — and the
 * message that guessed sent the owner looking for a person who was not there.
 */
export type SoEditLeaseRefusal = 'held' | 'expired' | 'missing';

/**
 * MAY THIS CALLER TAKE A LOCK SOMEBODY ELSE'S TOKEN IS HOLDING?
 *
 * Only when the holder is the same person - mig 0348. The owner asked for this
 * in one sentence: 「锁记住是谁上的 —— 同一个人直接拿回自己的锁」. A lock left by
 * your own crashed save is not a colleague editing; making you wait it out
 * protects nobody.
 *
 * BOTH IDS MUST BE REAL. A null holder is a lock written before 0348, or by a
 * path with no authenticated user, and it is never taken over - absence is the
 * stricter answer and the only safe reading of "we do not know whose this is".
 */
export function soEditLeaseTakeoverAllowed(
  /* `bigint` reaches the driver as a STRING, so both shapes are accepted here
     rather than cast at each call site - a cast is where one of them gets
     forgotten and the takeover silently stops working. */
  holderUserId: number | string | null | undefined,
  callerUserId: number | string | null | undefined,
): boolean {
  if (holderUserId == null || callerUserId == null) return false;
  if (String(holderUserId).trim() === '' || String(callerUserId).trim() === '') return false;
  return Number.isFinite(Number(holderUserId))
    && Number.isFinite(Number(callerUserId))
    && Number(holderUserId) === Number(callerUserId);
}

const MESSAGE: Record<SoEditLeaseRefusal, string> = {
  held: 'Someone else is saving this order right now. The lock clears itself within a minute — '
    + 'wait, then press Save again. Your changes are still here.',
  expired: 'The lock from an earlier save on this order has expired, so this save cannot use it. '
    + 'Reload the order and save again — your changes are still here.',
  missing: 'This screen tried to save without taking the edit lock first. Reload the order and '
    + 'save again — your changes are still here.',
};

/** The authenticated caller, as the lock records holders. One helper so no
 *  call site re-writes the Number.isFinite dance and quietly gets it wrong. */
export const soCallerUserId = (c: { get: (k: string) => any }): number | null => {
  const id = Number(c.get('houzsUser')?.id);
  return Number.isFinite(id) ? id : null;
};

export const soEditLeaseRefusal = (reason: SoEditLeaseRefusal) => ({
  error: 'so_edit_lease_conflict',
  /* The CODE stays one string. Screens, tests and the mobile surface all branch
     on `error`, and splitting it would be a wire change for a message fix. */
  reason,
  message: MESSAGE[reason],
} as const);

/** The lock columns as every reader of them sees them. */
export type SoEditLeaseRow = {
  edit_lease_token?: string | null;
  edit_lease_expires_at?: string | null;
};

/** The token of a lock that is STILL LIVE, or null. Expiry is the whole test —
 *  nothing here asks whether a screen is alive, because nothing can. */
export const activeSoEditLease = (row: SoEditLeaseRow | null | undefined): string | null => {
  const token = row?.edit_lease_token ?? null;
  const expires = row?.edit_lease_expires_at ? Date.parse(row.edit_lease_expires_at) : NaN;
  return token && Number.isFinite(expires) && expires > Date.now() ? token : null;
};

/** Does the caller hold this document's live lock? Moved here from
 *  scm/routes/mfg-sales-orders.ts so the rule and its lifetime live together. */
export const soLineWriteLeaseMatches = (
  row: SoEditLeaseRow | null | undefined,
  supplied: string,
): boolean => Boolean(supplied) && activeSoEditLease(row) === supplied;
