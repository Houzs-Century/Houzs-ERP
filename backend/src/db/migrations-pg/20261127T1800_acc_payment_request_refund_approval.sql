-- 20261127T1500_acc_payment_request_refund_approval.sql
-- REVERSAL: ALTER TABLE scm.acc_payment_requests DROP COLUMN IF EXISTS refund_approved_at,
--                                                DROP COLUMN IF EXISTS refund_approved_by_name,
--                                                DROP COLUMN IF EXISTS refund_approved_by;
--   Revert the code first: routes/payment-requests.ts selects these columns
--   (COLS) and writes them on approve-refund, lib/payment-request.ts refuses a
--   voucher for a refund request without refund_approved_at, and
--   lib/refund-request.ts reads them for the order's money panel. Dropping them
--   while that code runs refuses every refund voucher.
--   GRANTS: none to re-apply — columns ride their table's grants.
--
-- WHAT THIS CHANGES: three nullable columns on scm.acc_payment_requests —
--   who approved a refund request (public.users.id and the name as signed) and
--   when. Every existing row reads NULL: a refund request still waiting for
--   Finance now waits for this approval first; a plain request never uses them.
--
-- WHY (owner 2026-11-27): 「只要一级，但这一级的权限和cancel 的第二级一样」 then
--   Go ahead — a Sales Order's refund request is approved once, by whoever holds
--   the cancel level-2 right (scm.so_cancel.approve_l2), before Finance may
--   answer it with a Customer Refund voucher.
--
-- Verified against: staging (minnapsemfzjmtvnnvdd) via the Staging Migrations workflow before merge.

ALTER TABLE scm.acc_payment_requests
  ADD COLUMN IF NOT EXISTS refund_approved_by bigint,
  ADD COLUMN IF NOT EXISTS refund_approved_by_name text,
  ADD COLUMN IF NOT EXISTS refund_approved_at timestamptz;

COMMENT ON COLUMN scm.acc_payment_requests.refund_approved_at IS
  'A refund request''s one approval (owner 2026-11-27), by a holder of scm.so_cancel.approve_l2. NULL = not approved; Finance answers only an approved refund request.';
