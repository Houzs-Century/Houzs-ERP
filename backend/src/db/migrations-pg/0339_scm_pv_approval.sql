-- REVERSAL:
--   DROP INDEX IF EXISTS scm.idx_pv_awaiting_approval;
--   ALTER TABLE scm.payment_vouchers
--     DROP COLUMN IF EXISTS submitted_at, DROP COLUMN IF EXISTS submitted_by,
--     DROP COLUMN IF EXISTS approved_at,  DROP COLUMN IF EXISTS approved_by;
--
-- pv_approval — accounting phase 3: money leaves only after a yes.
--
-- The Daily Bank board has carried the placeholder since phase 2B
-- (acc/daily-bank.ts: "pending-approval vouchers subtract once the phase-3
-- approval flow exists"). This is that flow's schema half.
--
-- MARKER COLUMNS, NOT NEW STATUSES — the 0324 lesson (a hold that lived in
-- the status enum broke every `.eq('status', ...)` filter in the tree; a
-- marker column broke none). The voucher's lifecycle stays
-- DRAFT → POSTED → CANCELLED; the approval cycle lives entirely inside
-- DRAFT:
--
--   submitted_at/by  set by POST /:id/submit, cleared by withdraw or reject
--   approved_at/by   set by POST /:id/approve (scm.payment_voucher.approve),
--                    cleared by withdraw or reject
--
-- The gate is enforced in code at the ONE door money leaves through:
-- postPaymentVoucherHandler refuses a voucher whose approved_at is NULL.
-- Editing a submitted voucher is refused the same way — what was approved is
-- what gets paid, or it goes back through the queue.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS throughout; the partial index is the
-- Daily Bank board's read (every submitted-not-yet-paid voucher, per company).

ALTER TABLE scm.payment_vouchers
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_by TEXT,
  ADD COLUMN IF NOT EXISTS approved_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by  TEXT;

CREATE INDEX IF NOT EXISTS idx_pv_awaiting_approval
  ON scm.payment_vouchers (company_id)
  WHERE submitted_at IS NOT NULL AND status = 'DRAFT';
