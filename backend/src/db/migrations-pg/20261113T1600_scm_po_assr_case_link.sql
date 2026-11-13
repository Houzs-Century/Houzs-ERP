-- 20261113T1600_scm_po_assr_case_link.sql
-- REVERSAL:
--   DROP INDEX IF EXISTS scm.purchase_orders_assr_case_id_idx;
--   ALTER TABLE scm.purchase_orders DROP COLUMN IF EXISTS assr_case_id;
--   Revert the code first: the PO create handler stops accepting/storing
--   assrCaseId and getAssrDetail stops reading exchange_pos. Dropping the column
--   only removes the case<->exchange-PO link; no PO, stock or money is touched.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new
-- nullable column + one index on scm.purchase_orders. Every existing row keeps
-- assr_case_id NULL; nothing else is altered and no data moves.
--
-- WHY (owner 2026-11-13): a service case that does a one-to-one exchange needs to
-- raise a REAL purchase order (PO -> GRN -> purchase return / purchase invoice),
-- not the number-only "service PO" (assr_cases.po_no) it has today. This column
-- links the real exchange PO back to the case so the case detail can show it and
-- so the two cannot be confused with the SO-derived read-only order_pos.
-- public.assr_cases.id is bigint (verified in prod anogrigyjbduyzclzjgn), so the
-- FK column is bigint. ON DELETE SET NULL: deleting a case must never delete a PO.

SET search_path = public, scm;

ALTER TABLE scm.purchase_orders
  ADD COLUMN IF NOT EXISTS assr_case_id bigint NULL
    REFERENCES public.assr_cases(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS purchase_orders_assr_case_id_idx
  ON scm.purchase_orders (assr_case_id)
  WHERE assr_case_id IS NOT NULL;

-- PostgREST caches the schema; a new column the app reads through supabase-js
-- stays invisible until a reload (stale-schema 500s), so tell it to reload.
NOTIFY pgrst, 'reload schema';
