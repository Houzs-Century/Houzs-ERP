-- 20261123T1205_scm_so_product_changes.sql
--
-- REVERSAL: revert the code first (scm/lib/so-product-change-record.ts and its
--   callers, scm/lib/so-set-change-cost.ts, the Product changes reports). Then:
--     DROP TABLE IF EXISTS scm.so_product_changes;
--     ALTER TABLE scm.mfg_sales_order_items DROP COLUMN IF EXISTS cost_day, DROP COLUMN IF EXISTS set_cost_day;
--   The record of product changes is lost; no order total, cost or document
--   reads it. Line costs written under rule 2 stay as they are (they are plain
--   costs); a later save spreads the order-date set price again.
--   GRANTS: none to re-apply. The columns ride their table's grants and the new
--   table rides the scm schema's default privileges (service_role), like
--   scm.acc_department_settings; this file grants nothing.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: two new
-- nullable date columns on scm.mfg_sales_order_items (no default, nothing
-- written to existing rows), and one new, empty table under a new name. Nothing
-- existing is read or altered.
--
-- WHY (owner 2026-11-23). Rule 2: a product change after the order's opening day
-- (another SKU or model, a seat height that costs differently, sofa pieces added
-- or removed, a qty change that moves the selling amount, a line added) is costed
-- on the CHANGE day; unchanged lines keep the order-date cost (rule 1, PR #5811).
--   cost_day      the day a later product change priced this line; NULL = the
--                 order date.
--   set_cost_day  for a sofa piece: the day its set was last re-costed by rule 2
--                 (scm/lib/so-set-change-cost.ts). A save then leaves the set as
--                 costed that day instead of spreading the order-date set price
--                 over it again. NULL = never.
-- And a record of every product change, for Finance's two reports (「我主要是看销
-- 售价和成本的变动，因为我要确定这些改动销售价是足够cover成本的变动」): one row per
-- window of changes to one order, DIRECT (one Malaysia day of direct edits,
-- window_key = that day) or AMENDMENT (one submission, window_key = its first
-- amendment's id), with selling and cost before and after over PRODUCT lines.
-- bucket: SELLING (the selling amount changed), COST_ONLY (it did not, the cost
-- did); NULL = not an event (no product change, or nothing moved).
-- Verified against: production schema read 2026-11-23 (scm.mfg_sales_order_items
-- has neither column; scm.so_product_changes does not exist).

SET search_path = public, scm;

ALTER TABLE scm.mfg_sales_order_items
  ADD COLUMN IF NOT EXISTS cost_day date,
  ADD COLUMN IF NOT EXISTS set_cost_day date;

COMMENT ON COLUMN scm.mfg_sales_order_items.cost_day IS
  'Rule 2 (owner 2026-11-23): the day a product change after the order''s opening day priced this line. NULL = the order date.';
COMMENT ON COLUMN scm.mfg_sales_order_items.set_cost_day IS
  'Rule 2: the day this sofa piece''s set was re-costed after a change (so-set-change-cost.ts). A save leaves such a set alone. NULL = never.';

CREATE TABLE IF NOT EXISTS scm.so_product_changes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          bigint NOT NULL REFERENCES public.companies (id),
  so_doc_no           text NOT NULL,
  route               text NOT NULL CHECK (route IN ('DIRECT', 'AMENDMENT')),
  window_key          text NOT NULL,
  change_day          date NOT NULL,
  changed_at          timestamptz NOT NULL DEFAULT now(),
  changed_by          text[] NOT NULL DEFAULT '{}',
  approved_by         text[] NOT NULL DEFAULT '{}',
  amendment_nos       text[] NOT NULL DEFAULT '{}',
  change_types        text[] NOT NULL DEFAULT '{}',
  bucket              text CHECK (bucket IS NULL OR bucket IN ('SELLING', 'COST_ONLY')),
  selling_before_sen  bigint NOT NULL DEFAULT 0,
  selling_after_sen   bigint NOT NULL DEFAULT 0,
  cost_before_sen     bigint NOT NULL DEFAULT 0,
  cost_after_sen      bigint NOT NULL DEFAULT 0,
  lines               jsonb NOT NULL DEFAULT '[]'::jsonb,
  before_lines        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT so_product_changes_window_uq UNIQUE (company_id, so_doc_no, route, window_key)
);

CREATE INDEX IF NOT EXISTS so_product_changes_month_idx
  ON scm.so_product_changes (company_id, change_day)
  WHERE bucket IS NOT NULL;

ALTER TABLE scm.so_product_changes ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
