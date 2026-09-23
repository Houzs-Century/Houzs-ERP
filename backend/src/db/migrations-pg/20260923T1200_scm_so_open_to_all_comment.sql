-- 20260923T1200_scm_so_open_to_all_comment.sql
-- REVERSAL: re-run 20260911T1500's COMMENT ON COLUMN statement verbatim. Nothing
--   else to undo — this migration changes no row, no type and no constraint.
--   GRANTS: none.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--
-- ONE comment. `COMMENT ON COLUMN` rewrites a catalogue string; it takes no
-- lock worth the name, touches no data and cannot fail on an existing row.
--
-- WHY IT EXISTS. 20260911T1500 labelled the column "VISIBILITY ONLY" and then,
-- in the same sentence, said every user may "SEE and (subject to the state
-- locks) EDIT" the order. Both halves are true and the label is the one people
-- read: on 2026-09-23 a Sales Executive was found editing HC-SO-003645 — an
-- order whose salesperson is someone else and whose share list does not name
-- him — and the trace ran straight through this flag. `soDocOutOfScope`
-- short-circuits on it, and the SO WRITE gate (`selfScopedSalesBlocked`) calls
-- that same helper, so the flag opens all ~18 mutation routes, not just the
-- reads. A column comment that says "visibility only" is the wrong thing to
-- find when you are asking why somebody could write.
--
-- It also re-points the "who sets this" half. The owner narrowed the rule the
-- same day — 「未交完的 2,580 张保持 open,其余收回去」 — so the one-shot
-- backfill is replaced by a reconciler that converges in both directions
-- (backend/scripts/reconcile-so-open-to-all.mjs + the workflow of the same
-- name). The rule itself lives in scripts/lib/so-open-to-all-rule.mjs.

SET search_path = public, scm;

COMMENT ON COLUMN scm.mfg_sales_orders.open_to_all IS
  'true = every user may SEE **and EDIT** this order, bypassing access_staff_ids scope: soDocOutOfScope short-circuits on it and the SO write gate selfScopedSalesBlocked calls that same helper, so it opens the mutation routes too (the state locks still apply). No attribution, no commission, nothing AutoCount reads. The rule, since owner 2026-09-23: imported AutoCount orders that are NOT in a terminal status. Maintained by backend/scripts/reconcile-so-open-to-all.mjs (re-runnable; nothing withdraws the flag automatically when a status changes). See docs/modules/sales-order.md.';
