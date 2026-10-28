-- 0149_scm_so_amendment_resolution_and_edits.sql
--
-- Owner 2026-07-19, two reports against the live amendment workflow:
--
--   (1) "once I submit an amendment it just sits in REQUESTED and I have no way
--       to correct a mistake — my only option is to submit ANOTHER one." That
--       produced two or three competing amendment documents against one Sales
--       Order and nobody could tell which was authoritative.
--
--   (2) from the SO-2607-015/A1 screenshot: there is no Reject control anywhere
--       and nowhere to type a rejection reason. The backend gate existed
--       (PATCH /so-amendments/:id/reject) but the reason was OPTIONAL and was
--       written only into the mfg_so_audit_log NOTE — so_amendments had no
--       column for it at all. The requester could not see WHY their request was
--       refused without someone opening the SO's history drawer for them.
--
-- This migration adds the columns those two need. No new status: withdraw and
-- reject both land on the existing terminal REJECTED, which is what frees the
-- uq_so_amendment_open partial unique index so a corrected request can be
-- raised. `resolution` is what distinguishes them for a reader.
--
-- Houzs conventions (mirrors 0080_scm_so_amendment_workflow.sql):
--   * schema-qualified to scm.*; SET search_path = scm, public.
--   * NO inner BEGIN/COMMIT — the pg-migrate runner owns ONE transaction.
--   * Additive + IF NOT EXISTS -> re-run safe.
--
-- VIEW-TRAP NOTE: so_amendments is not enumerated by any view, so these plain
-- ADD COLUMNs cannot invalidate one (contrast the mfg_sales_orders.revision
-- note in 0080).
--
-- Apply BEFORE deploying the dependent API code (migrate-before-deploy).

SET search_path = scm, public;

-- Resolution half — who closed the amendment, when, and WHY -------------------
-- rejected_by is the scm.staff uuid of the real caller (resolveCallerStaffId),
-- NOT the bridge's pinned system row: the whole point is answering "who said no".
ALTER TABLE scm.so_amendments ADD COLUMN IF NOT EXISTS rejected_by uuid;
ALTER TABLE scm.so_amendments ADD COLUMN IF NOT EXISTS rejected_at timestamptz;
ALTER TABLE scm.so_amendments ADD COLUMN IF NOT EXISTS rejection_reason text;

-- 'REJECTED' (an approver refused it) vs 'WITHDRAWN' (the requester pulled it
-- back). Both sit on status = REJECTED so the state machine and the one-open
-- index are untouched; this column is what lets the UI, and the requester, tell
-- a refusal apart from their own retraction. NULL for every pre-0149 row and for
-- an amendment that is still in flight.
ALTER TABLE scm.so_amendments ADD COLUMN IF NOT EXISTS resolution text;

-- Edit half — an amendment corrected in place while still REQUESTED -----------
-- The audit trail (mfg_so_audit_log, action AMENDMENT_EDITED) is the record of
-- WHAT changed; these two are the at-a-glance "this has been revised since it
-- was raised" signal the approver needs on the card itself.
ALTER TABLE scm.so_amendments ADD COLUMN IF NOT EXISTS edited_at timestamptz;
ALTER TABLE scm.so_amendments ADD COLUMN IF NOT EXISTS edit_count integer NOT NULL DEFAULT 0;
