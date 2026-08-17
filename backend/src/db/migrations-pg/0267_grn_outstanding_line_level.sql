-- 0267 — v_grn_outstanding: "still to bill" is a LINE fact, not a header FK.
--
-- Owner 2026-08-06 (multi-note purchase invoices). One supplier invoice may now
-- bill several goods-received notes; the PI header's grn_id is only the PRIMARY
-- note ref, while the authoritative linkage is per line
-- (purchase_invoice_items.grn_item_id → grn_items).
--
-- The old predicate asked "does ANY purchase_invoice point at this GRN's id?",
-- which broke twice:
--   • a note billed on ANOTHER note's invoice kept is_outstanding = TRUE
--     forever (its lines are fully invoiced, but no PI header names it), and
--   • a note that was only PARTLY billed flipped to FALSE on the first invoice,
--     hiding the remainder — the flag was header-presence, not quantity.
--
-- Both are answered by the same counters the rest of the system already trusts
-- (grn_items.invoiced_qty / returned_qty, maintained by recomputeGrnInvoiced and
-- read by computeGrnFlags, lib/grn-consumption-flags): a note is outstanding while ANY of its lines still
-- has accepted − invoiced − returned > 0. A note with no lines at all is not
-- outstanding (nothing to bill), matching computeGrnFlags (lib/grn-consumption-flags).
--
-- Consumers: backend/src/scm/routes/outstanding.ts (the Outstanding → GRN tab).
-- Columns and their order are unchanged, so the route needs no edit.

-- search_path is pinned to scm exactly as 0084 does, and every table ref is
-- schema-qualified. Without the pin an unqualified `grns` binds to public.grns
-- (a different table with no company_id) → the migration fails with
-- "column g.company_id does not exist" and BLOCKS the deploy.
SET search_path TO scm, public;

CREATE OR REPLACE VIEW scm.v_grn_outstanding AS
SELECT
  g.id, g.grn_number, g.supplier_id, g.received_at, g.status,
  g.created_at,
  CASE
    WHEN g.status = 'CANCELLED' THEN FALSE
    WHEN EXISTS (
      SELECT 1
      FROM scm.grn_items gi
      WHERE gi.grn_id = g.id
        AND (COALESCE(gi.qty_accepted, 0)
             - COALESCE(gi.invoiced_qty, 0)
             - COALESCE(gi.returned_qty, 0)) > 0
    ) THEN TRUE
    ELSE FALSE
  END AS is_outstanding,
  g.company_id
FROM scm.grns g;
