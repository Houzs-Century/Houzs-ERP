// ----------------------------------------------------------------------------
// autocount-claim — who is sending a queue row RIGHT NOW.
//
// WHY IT IS ITS OWN MODULE. Two dispatchers now reach `dispatchOne`: the
// 5-minute sweep and the AutoCount Sync page's "Send now". Until the second one
// existed nothing in `scm.autocount_outbox` could express "somebody is sending
// this" — the drain's SELECT takes no lock, `mark()` carries no status
// predicate, and there was no lease column — and that was safe for exactly one
// reason: a single caller cannot race itself. A human with a button spends that
// safety, and the cost of losing it is one document written into a licensed
// account book twice.
//
// So the claim is a rule about the TABLE rather than about either caller, and
// it lives beside neither. `autocount-outbox.ts` is the composer and the drain;
// `autocount-requeue.ts` is the re-send ladder. Both take the claim, neither
// owns it.
//
// PURE-ISH: one Supabase client in, a boolean out. No env, no fetch, no payload
// composition.
// ----------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js';

type Sb = SupabaseClient<any, any, any>;

/**
 * How long a dispatcher's claim on a row is believed (migration 0315).
 *
 * A LEASE AND NOT A LOCK, because the process holding it can die: a Worker's
 * `ctx.waitUntil` is not guaranteed to finish, and a claim that outlived its
 * claimant would wedge the row forever — queued, visibly waiting, and dead,
 * which is the exact failure the re-queue INSERT exists to avoid.
 *
 * Longer than the 5-minute cron period on purpose, so a send that is slow but
 * ALIVE is never stolen from and sent twice; short enough that a send killed
 * mid-flight costs a sweep or two rather than a morning. Ten minutes is two
 * sweeps.
 */
export const AC_CLAIM_LEASE_MS = 10 * 60 * 1000;

/**
 * TAKE THIS ROW, or find out that somebody else already has it.
 *
 * WHY THIS EXISTS AT ALL. Until the AutoCount Sync page grew a "Send now"
 * button there was exactly ONE dispatcher — the 5-minute cron — and a single
 * caller cannot race itself. Nothing else guarded the table: the drain's SELECT
 * takes no lock, `mark()` carries no status predicate, and there is no lease
 * column. The safety was structural luck, and a human who can press a button is
 * the second dispatcher that spends it. Two presses, or a press landing inside a
 * sweep, would otherwise send one document into a licensed account book twice.
 *
 * ATOMIC BECAUSE IT IS ONE STATEMENT. `UPDATE … WHERE … RETURNING` is evaluated
 * under a row lock: a second claimant blocks, and when it is let through
 * Postgres re-checks its predicate against the row as it NOW stands (READ
 * COMMITTED re-evaluation). It therefore sees the claim the first one took and
 * matches nothing. A read-then-write would have a window between the two halves;
 * this has none, which is the same reason `requeueOutboxRow` puts both its
 * predicates on one statement.
 *
 * A STALE CLAIM IS NOT A CLAIM. Anything older than the lease is treated as
 * abandoned and may be taken again — see AC_CLAIM_LEASE_MS for why a killed
 * Worker must not be able to strand a document.
 *
 * Returns false for "somebody else has it", for "it is no longer pending", and
 * for a query error, and the caller must treat all three the same way: do not
 * send. Failing closed here costs at most one sweep's delay; failing open costs
 * a duplicate accounting document.
 */
export async function claimOutboxRow(sb: Sb, rowId: string): Promise<boolean> {
  const { data, error } = await sb.from('autocount_outbox')
    .update({ claimed_at: new Date().toISOString() })
    .eq('id', rowId)
    /* STILL PENDING. A row that reached `sent` or `failed` between the caller's
       read and this write must not be dispatched, and this predicate is the only
       thing that can notice. */
    .eq('status', 'pending')
    /* UNCLAIMED. `is`, never `eq`: `claimed_at = NULL` is NULL and not true in
       SQL, so an `eq` null test matches nothing and every claim would be lost. */
    .is('claimed_at', null)
    .select('id')
    .maybeSingle();
  if (error) return false;
  return data !== null;
}

/**
 * Let go of claims whose holder is gone, so their rows can be sent again.
 *
 * THE OTHER HALF OF THE LEASE, kept as its own statement rather than folded into
 * `claimOutboxRow`'s predicate. Two reasons, and the second is the one that
 * decided it:
 *
 *   - "unclaimed OR the claim is stale" is one predicate doing two jobs, and the
 *     second job is not about the row being claimed — it is about time passing.
 *     Expiry is a sweep's business, and the sweep already exists.
 *   - a claim taken by a LIVE sender must never be stolen, and a predicate that
 *     silently reclaims on age cannot tell a slow sender from a dead one. Making
 *     expiry a separate, explicit act keeps that decision in one visible place
 *     with the lease constant next to it.
 *
 * Run once per sweep, before anything is selected. A row released here is simply
 * pending and unclaimed again; nothing about its attempts, status or reason
 * changes, because nothing about them became untrue — only the claim did.
 */
export async function releaseExpiredClaims(sb: Sb): Promise<void> {
  const staleBefore = new Date(Date.now() - AC_CLAIM_LEASE_MS).toISOString();
  await sb.from('autocount_outbox')
    .update({ claimed_at: null })
    .eq('status', 'pending')
    /* `lte` compares timestamps as PostgREST does for a timestamptz column, and
       an exactly-on-the-boundary claim being released is the harmless direction:
       it costs one extra dispatch attempt, never a duplicate, because the claim
       itself is still the thing that decides who sends. */
    .lte('claimed_at', staleBefore);
}
