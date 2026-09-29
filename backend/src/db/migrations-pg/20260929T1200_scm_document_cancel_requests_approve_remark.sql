-- 20260929T1200_scm_document_cancel_requests_approve_remark.sql
-- REVERSAL: ALTER TABLE scm.document_cancel_requests DROP COLUMN IF EXISTS l1_remark;
--   ALTER TABLE scm.document_cancel_requests DROP COLUMN IF EXISTS l2_remark;
--   Loses any remark an approver wrote; the signatures themselves are untouched.
--
-- WHAT THIS ADDS: two nullable text columns on scm.document_cancel_requests,
-- l1_remark and l2_remark — what each approver wrote when signing a Sales
-- Order cancellation.
--
-- WHY (DEV-17, 2026-09-25: "SO cancel need to key in remarks function"). The
-- requester writes a reason and a rejecting approver writes one, but an
-- approving signature carried no words at all. The remark is OPTIONAL — NULL
-- when the approver signed without one — so no existing row needs a value.
--
-- RE-RUN: safe. ADD COLUMN IF NOT EXISTS.

ALTER TABLE scm.document_cancel_requests ADD COLUMN IF NOT EXISTS l1_remark text;

ALTER TABLE scm.document_cancel_requests ADD COLUMN IF NOT EXISTS l2_remark text;
