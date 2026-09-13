-- ----------------------------------------------------------------------------
-- 20260913T1900 — record HOW a sales order's fair link was decided.
--
-- WHY. `scm.mfg_sales_orders.project_id` has existed since #814 and, measured on
-- production on 2026-09-13, was NULL on all 2,946 of Houzs Century's orders —
-- so no order in the account book could say which exhibition it was written at.
-- The fair picker (owner, 2026-09-13) fixes the capture. This column fixes the
-- READ side of it: a NULL project_id cannot tell a report the difference between
--
--   * the fair has not been created in PMS yet (23% of fairs reach the system
--     within a week of opening; 13 of 114 arrived AFTER they had started),
--   * two brand booths fit and the order's own lines cannot say which,
--   * the order sells a brand that has no booth at that event,
--   * nobody has touched this order since before the picker existed.
--
-- Those are four different actions for four different people, and without this
-- column they are one indistinguishable blank. `fair_match` names which.
--
-- NULL stays NULL on every existing row ON PURPOSE. Back-stamping 2,946 orders
-- with a verdict this migration did not compute would be manufacturing the
-- evidence the reconcile job exists to gather. The nightly reconcile
-- (backend/scripts/reconcile-so-fair.mjs) fills them in from real matches.
--
-- Values, written only by the SO create/patch path and the reconcile script:
--   PICKED     project_id is set and was resolved from a picked event + brand
--   PENDING    a venue is recorded, no fair exists there on that date YET
--   AMBIGUOUS  more than one booth fits — a person decides, the system does not
--   UNMATCHED  a fair exists, the order's brand has no booth at it
--
-- REVERSAL: ALTER TABLE scm.mfg_sales_orders DROP COLUMN fair_match;
--           DROP INDEX IF EXISTS scm.idx_mfg_so_fair_match;
--           (Additive and nullable — dropping it loses the four-way verdict but
--           no money, no stock and no document. project_id is untouched here.)
--
-- Verified against: production schema (anogrigyjbduyzclzjgn) read 2026-09-13 via
-- the Supabase MCP — scm.mfg_sales_orders carries project_id (bigint, NULL on
-- 2,946/2,946 Houzs Century rows) and no column named fair_match.
-- ----------------------------------------------------------------------------

ALTER TABLE scm.mfg_sales_orders
  ADD COLUMN IF NOT EXISTS fair_match text;

-- The pending screen and the reconcile job both read "orders still needing a
-- fair", which is a small slice of a large table. Partial index so it costs
-- nothing on the 99% of rows that are settled.
CREATE INDEX IF NOT EXISTS idx_mfg_so_fair_match
  ON scm.mfg_sales_orders (company_id, so_date)
  WHERE fair_match IN ('PENDING', 'AMBIGUOUS', 'UNMATCHED');

COMMENT ON COLUMN scm.mfg_sales_orders.fair_match IS
  'How the fair link was decided: PICKED | PENDING | AMBIGUOUS | UNMATCHED. NULL = predates the fair picker (2026-09-13). See scm/lib/fair-options.ts.';
