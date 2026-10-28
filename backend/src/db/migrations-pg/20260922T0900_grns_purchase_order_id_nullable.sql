-- 20260922T0900_grns_purchase_order_id_nullable.sql
-- REVERSAL: ALTER TABLE scm.grns ALTER COLUMN purchase_order_id SET NOT NULL; —
--   but do NOT reverse: a manual / no-PO Goods Receipt legitimately has no parent
--   purchase order, so re-adding the constraint re-breaks that feature. Reversing
--   would first require deleting every no-PO grn, which is real data. GRANTS: none.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--
-- Drops the NOT NULL on scm.grns.purchase_order_id. Making it nullable can never
-- fail an existing row (every current row has a value) and does not touch data.
--
-- WHY IT EXISTS. The GRN create path has supported a receipt with NO parent PO
-- since 2026-05-29 (routes/grns.ts: "a GRN may now be created WITHOUT a parent
-- PO" — a blank/manual receipt, or a service charge like repair fees with no
-- source PO), inserting purchase_order_id = NULL. But scm.grns.purchase_order_id
-- was still NOT NULL in production (public.grns had already been made nullable),
-- so every no-PO GRN 500'd with
--   null value in column "purchase_order_id" of relation "grns" violates not-null constraint
-- Owner 2026-09-22: "New Goods Receipt" for RC-COM (REPAIR CHARGES - PAY BY
-- COMPANY, no PO) failed with "The system hit a problem". This closes that gap so
-- the manual-receipt feature the application already offers actually saves.

SET search_path = public, scm;

ALTER TABLE scm.grns ALTER COLUMN purchase_order_id DROP NOT NULL;
