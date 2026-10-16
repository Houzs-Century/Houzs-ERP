-- 20261008T1510_acc_payment_request_checklist_item.sql
-- REVERSAL: DROP INDEX IF EXISTS scm.idx_acc_payment_requests_checklist_item;
--           ALTER TABLE scm.acc_payment_requests DROP COLUMN IF EXISTS checklist_item_id;
--   Revert the code first: routes/payment-requests.ts selects the column (COLS),
--   writes it on create and on 申请付余额, and GET /payment-requests/from-checklist
--   filters on it. Dropping it loses only which PMS row a request was raised
--   from — the requests, their bills and their events stay.
--   GRANTS: none to re-apply — a column and an index ride their table's grants.
--
-- WHAT THIS CHANGES: one nullable column on scm.acc_payment_requests,
--   checklist_item_id bigint — the PMS checklist row (public.project_checklist.id)
--   a request was raised from with the row's own 「Request payment」 button, and
--   a partial index for the PMS page's read of a table's rows. Every existing
--   request reads NULL (raised on the Payment Requests page). No foreign key:
--   the row lives in the public schema, read through env.DB under the active
--   company (lib/pms-checklist-source.ts); a deleted checklist row leaves its
--   requests whole.
--
-- WHY (owner 2026-10-08): 「我的bd 会upload rental invoice 在这里 [an event's
-- CONTRACT › Agreement / Quotation row]，可以让他连过来for request payment 吗 …
-- 就在这里加request payment … 做」 — the bill the BD already uploaded becomes the
-- request's bill, and the row shows the request and its 欠正式单 state.
--
-- Verified against: staging (minnapsemfzjmtvnnvdd) via apply_migration before merge.

ALTER TABLE scm.acc_payment_requests
  ADD COLUMN IF NOT EXISTS checklist_item_id bigint;

CREATE INDEX IF NOT EXISTS idx_acc_payment_requests_checklist_item
  ON scm.acc_payment_requests (company_id, checklist_item_id)
  WHERE checklist_item_id IS NOT NULL;
