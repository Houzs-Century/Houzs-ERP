-- 20260914T1800_scm_document_cancel_requests_do.sql
-- REVERSAL: DELETE FROM scm.document_cancel_requests WHERE doc_type = 'DO';
--   ALTER TABLE scm.document_cancel_requests DROP CONSTRAINT IF EXISTS document_cancel_requests_doc_type_check;
--   ALTER TABLE scm.document_cancel_requests ADD CONSTRAINT document_cancel_requests_doc_type_check CHECK (doc_type IN ('SO', 'PO'));
--   The DELETE is only needed once a delivery order has been cancelled under the
--   new rule, and it loses those reasons from the ledger — the same reasons stay
--   on each delivery order's own history (scm.entity_audit_log, action CANCEL),
--   which this reversal does not touch. No table, column, index or GRANT is
--   created or dropped, so there is nothing else to put back.
--
-- WHAT THIS CHANGES: one CHECK constraint on scm.document_cancel_requests. The
-- ledger of cancellations (mig 20260908T1400) accepted doc_type 'SO' and 'PO'
-- only; it now accepts 'DO' as well. No row changes, no column changes.
--
-- WHY (owner, 2026-09-14: 「DO cancel need pop out window for reason」). A
-- delivery order is cancelled on its REASON alone, the rule the Purchase Order
-- has had since 2026-09-09: the guard in front of
-- PATCH /api/scm/delivery-orders-mfg/:id/status refuses a cancel without a
-- reason and, once the cancel has run, writes an EXECUTED row here beside the
-- purchase orders' — so "who cancelled this delivery order, and why" is
-- answered in the same Cancellation Requests list. Until this constraint
-- allows 'DO', that insert is refused (it is best-effort, so the cancel itself
-- would still succeed and the reason would still reach the delivery order's
-- history — only the ledger row would be missing).
--
-- THE CONSTRAINT NAME IS THE LIVE ONE, not a guess from the file that created
-- it: the CREATE TABLE declared the check inline, unnamed, so Postgres named it.
-- Read on production (anogrigyjbduyzclzjgn) on 2026-09-14T09:17Z from
-- pg_constraint: `document_cancel_requests_doc_type_check`,
-- CHECK ((doc_type = ANY (ARRAY['SO'::text, 'PO'::text]))), with the table
-- holding 3 rows, all PO / EXECUTED — so the new constraint validates cleanly.
--
-- ORDER. deploy.yml applies pending migrations BEFORE the Worker deploys, so the
-- constraint accepts 'DO' by the time the new guard writes one. pg-migrate runs
-- a multi-statement file inside ONE transaction, so there is no moment between
-- the DROP and the ADD where the column is unconstrained.
--
-- RE-RUN: safe. DROP ... IF EXISTS then ADD leaves the same single constraint.

ALTER TABLE scm.document_cancel_requests DROP CONSTRAINT IF EXISTS document_cancel_requests_doc_type_check;

ALTER TABLE scm.document_cancel_requests
  ADD CONSTRAINT document_cancel_requests_doc_type_check CHECK (doc_type IN ('SO', 'PO', 'DO'));
