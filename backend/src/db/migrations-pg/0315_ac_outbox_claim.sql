-- WHO IS SENDING THIS ROW RIGHT NOW.
--
-- THE HOLE THIS CLOSES, and it is a pre-existing one. `drainAutoCountOutbox`
-- SELECTs pending rows and then calls `dispatchOne` on each. Nothing between
-- those two steps marks a row as in-flight: there is no lock, no lease, no
-- conditional UPDATE, and `mark()` carries no status predicate. Two dispatchers
-- running at once would both select the same row and both send it, and the
-- second send is a SECOND accounting document in a licensed book.
--
-- Until now that could not happen for one reason only: there has been exactly
-- ONE dispatcher, the 5-minute cron, and a single caller cannot race itself.
-- That is luck standing in for a guard, and the moment a human can press "Send
-- now" the luck runs out -- two operators, or one operator and a sweep, is the
-- ordinary case and not the exotic one.
--
-- WHY A COLUMN AND NOT THE ATTEMPT COUNTER. A compare-and-swap on `attempts`
-- would work and needs no migration, and it was the first design. It was
-- dropped because `dispatchOne` has an outcome -- `waiting`, the parent has no
-- AutoCount number yet -- that deliberately does NOT burn an attempt
-- (autocount-outbox.ts, and autocount-drain.test.ts pins it twice). Claiming by
-- incrementing `attempts` would burn one on every waiting row and then have to
-- put it back, which makes the counter briefly untrue and makes a crash leave it
-- permanently untrue. `attempts` means "times we asked AutoCount" and must keep
-- meaning exactly that.
--
-- A LEASE, NOT A LOCK. A Worker can be killed mid-send (ctx.waitUntil is not
-- guaranteed to finish), and a claim that outlives the process that took it
-- would wedge the row forever -- queued, visibly waiting, and dead, which is the
-- same failure mode the re-queue INSERT exists to avoid. So a claim EXPIRES:
-- any claimant older than AC_CLAIM_LEASE_MS is treated as gone and the row may
-- be claimed again. The lease is deliberately longer than the cron period, so a
-- slow-but-alive send is never stolen from, and short enough that a crashed one
-- costs at most a sweep or two.
--
-- NULL is the normal state and means "nobody is sending this". It is not a
-- status: the row is still `pending` while claimed, because it IS still pending
-- -- 0277's CHECK admits four statuses and a fifth would be a lie to every
-- reader of this table.
--
-- REVERSAL: ALTER TABLE scm.autocount_outbox DROP COLUMN claimed_at;
--   Safe only with the code that reads it. The column is additive and nullable,
--   nothing joins on it and no constraint depends on it, so dropping it returns
--   the table to exactly its previous shape -- and returns the drain to being
--   safe by luck rather than by construction, which is the thing to know before
--   dropping it.

ALTER TABLE scm.autocount_outbox
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

COMMENT ON COLUMN scm.autocount_outbox.claimed_at IS
  'When a dispatcher took this row to send it, or NULL when nobody holds it. A LEASE: a claim older than the drain''s lease constant is treated as abandoned and may be taken again, because a Worker killed mid-send would otherwise wedge the row forever. Set by the conditional claim in scm/lib/autocount-outbox.ts (claimOutboxRow) and cleared by mark() on every outcome. Not a status -- the row stays pending while claimed.';

-- The claim predicate's own lookup. The drain already selects on
-- (status, attempts, created_at) through autocount_outbox_pending_idx; this
-- keeps the "is it claimed, and is that claim stale" half from widening that
-- scan as the history grows. Partial for the same reason 0277's is: it stays the
-- size of the in-flight set, which is normally zero.
CREATE INDEX IF NOT EXISTS autocount_outbox_claimed_idx
  ON scm.autocount_outbox (claimed_at)
  WHERE claimed_at IS NOT NULL;
