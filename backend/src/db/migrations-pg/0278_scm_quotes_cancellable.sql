-- 0278_scm_quotes_cancellable.sql — give scm.quotes a retirement path that is
-- not deletion.
--
-- WHY. The owner's rule is 不可以删只可以 cancel: nothing is ever deleted, only
-- cancelled. DELETE /api/scm/quotes/:id (quotes.ts) hard-purged a quote row with
-- NO status guard of any kind — the least guarded of the three document-level
-- hard deletes found on the SCM route surface (the other two, purchase orders
-- and PC orders, were removed in #1939 and the PR carrying this file).
--
-- Removing that delete on its own would have left the module with no way to
-- retire a quote at all. scm.quotes (mig 0101) has no status column; `expires_at`
-- is written by nothing; `promoted_to_order_id` is set only by a conversion that
-- has already happened. Delete WAS the retirement path. So the delete goes and
-- these two columns arrive together, and PATCH /quotes/:id/cancel uses them.
--
-- Shape mirrors the sibling documents' cancel columns (scm.purchase_consignment
-- _orders.cancelled_at, scm.delivery_orders.cancelled_at): a nullable timestamp
-- plus the actor. cancelled_by is uuid with NO FK to scm.staff, matching
-- quotes.created_by (mig 0101 precedent — the SCM auth bridge can pin a caller
-- to the seeded system-staff uuid, so an FK would refuse legitimate writes).
--
-- Idempotent + re-run-safe: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT
-- EXISTS throughout. No backfill: every existing row is open, and NULL is
-- exactly what "not cancelled" means.

ALTER TABLE scm.quotes ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE scm.quotes ADD COLUMN IF NOT EXISTS cancelled_by uuid;

-- The open-list index from 0101 filtered on promoted_to_order_id alone. "Open"
-- now means not promoted AND not cancelled, so the partial index has to agree
-- with the query or the list stops using it. Old name kept out of the way.
CREATE INDEX IF NOT EXISTS idx_quotes_open_v2
  ON scm.quotes (created_at DESC)
  WHERE promoted_to_order_id IS NULL AND cancelled_at IS NULL;
