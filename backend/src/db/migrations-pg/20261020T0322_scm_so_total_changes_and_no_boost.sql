-- 20261020T0322_scm_so_total_changes_and_no_boost.sql
-- REVERSAL: revert the code first (scm/lib/so-total-changes.ts is written from
--   routes/mfg-sales-orders.ts recomputeTotals; scm/lib/event-commission.ts and
--   routes/acc-event-commission.ts read it), then
--   (1) DROP TABLE IF EXISTS scm.so_total_changes;   — loses the change history
--       recorded since go-live; nothing else references it.
--   (2) put the boost back on the rate cards, the values as they stood on
--       2026-10-20 (read-only, check-commission-setup.mjs):
--       UPDATE public.project_cost_rates SET commission_boost_pct = 17, boost_min_gp_pct = 57, boost_min_sales = 130000
--        WHERE brand IN ('AKEMI', 'Carres Mattress', 'ERGOTEX', 'MYLATEX');
--       UPDATE public.project_cost_rates SET commission_boost_pct = 15, boost_min_gp_pct = 55, boost_min_sales = 130000 WHERE brand = 'DUNLOPILLO';
--       UPDATE public.project_cost_rates SET commission_boost_pct = 15, boost_min_gp_pct = 56, boost_min_sales = 130000 WHERE brand = 'ZANOTTI';
--       UPDATE public.project_cost_rates SET commission_boost_pct = 15, boost_min_gp_pct = NULL, boost_min_sales = 130000 WHERE brand = 'MY SOFA FACTORY';
--   GRANTS: the explicit service_role grant below goes with the table.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   1. One new empty table, scm.so_total_changes, and its indexes.
--   2. The brand rate cards (public.project_cost_rates) lose their commission
--      boost: commission_boost_pct, boost_min_gp_pct and boost_min_sales are
--      cleared on every card that has one (7 of 8 brands; AKEMI Cash & Carry
--      has none). The normal % is untouched. services/eventPnl.ts already reads
--      "no boost %" as no boost, so every event's Commission row is the normal
--      % of its sales from the moment this runs — 3 of the 36 Houzs fairs since
--      09-01 were on the boost (17% → 14%).
-- Verified against: staging via staging-migrate.yml on this branch (see the PR).
--
-- WHY (owner 2026-10-20). Event Commission: each fair's commission and each
-- order's under it, with the order's upsales / drop sales — 「这个也要在 event
-- commission 那边看到」, recorded from go-live (「9/1到上线前的先不补」). No
-- table held an order's total over time; the 2026-10-13 Excel had to rebuild it
-- from the audit log. One row per change of an order's goods or total, written
-- where every line change already rolls the header up (recomputeTotals), so a
-- direct edit, an approved amendment and a free-gift reconcile all land here.
-- And 「这个要修改一下，没有升级后的了」: no boost any more.

CREATE TABLE IF NOT EXISTS scm.so_total_changes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        BIGINT NOT NULL,
  so_doc_no         TEXT NOT NULL,
  changed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- goods = the four goods buckets (mattress_sofa + bedframe + accessories +
  -- others); delivery and service are not goods (they earn no commission).
  before_goods_sen  BIGINT NOT NULL,
  after_goods_sen   BIGINT NOT NULL,
  before_total_sen  BIGINT NOT NULL,
  after_total_sen   BIGINT NOT NULL,
  -- 'edit' | 'amendment' | 'system' — what the request that changed it was.
  source            TEXT NOT NULL,
  changed_by        TEXT
);

CREATE INDEX IF NOT EXISTS idx_so_total_changes_company_at ON scm.so_total_changes (company_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_so_total_changes_doc ON scm.so_total_changes (so_doc_no, changed_at);

-- The Worker reads and writes as service_role; granted explicitly rather than
-- trusting the schema's default privileges (a local restore lacked them).
GRANT SELECT, INSERT, UPDATE, DELETE ON scm.so_total_changes TO service_role;

UPDATE public.project_cost_rates
   SET commission_boost_pct = NULL, boost_min_gp_pct = NULL, boost_min_sales = NULL
 WHERE commission_boost_pct IS NOT NULL OR boost_min_gp_pct IS NOT NULL OR boost_min_sales IS NOT NULL;
