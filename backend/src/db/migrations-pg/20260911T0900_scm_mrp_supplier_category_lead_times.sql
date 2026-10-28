-- 20260911T0900_scm_mrp_supplier_category_lead_times.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.mrp_supplier_category_lead_times;
--
-- WHAT THIS ADDS: one table, scm.mrp_supplier_category_lead_times — the owner's
-- MANUAL per-(supplier, category) lead time, set on the supplier page.
--
-- WHY (owner, 2026-09-11: 「如果我有 Supplier lead time 的话，系统应该根据
-- Supplier lead time 走更高的优先级...我会在每一个 Supplier 去 set 它的 Category
-- lead time 多久，然后根据我的送货时间去 set 给它 PO 的 delivery date」):
--   The base table scm.mrp_category_lead_times sets lead days per (warehouse,
--   category). The owner wants to override that PER SUPPLIER: this supplier's
--   sofa takes N days, regardless of the category default. When present, this
--   value takes PRIORITY over the base category number when the convert computes
--   the PO delivery date (delivery date - lead days). See scm/lib/lead-time.ts:
--   this override REPLACES the base layer; the agent's learned supplier/season
--   buffers still add on top (both empty until approved, so no change today).
--
-- SHAPE. Keyed by supplier_id (uuid FK), not supplier code — the id is stable
-- across a code re-key, and the supplier page edits by row. company_id scopes it
-- to one book. category is the same 5-value text CHECK as the base table. One
-- lead-days row per (company, supplier, category): the unique index is the floor.
-- Empty table = no override = the base wins, so this ships as a PURE NO-OP until
-- the owner enters values; nothing changes on any existing PO.
--
-- Plain CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS, schema-
-- qualified, no DO block (pg-migrate splits on ";\n"), no enum (text CHECK is
-- reversible; ADD VALUE is not). Additive and re-run safe.

CREATE TABLE IF NOT EXISTS scm.mrp_supplier_category_lead_times (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   bigint NOT NULL REFERENCES public.companies(id),
  supplier_id  uuid NOT NULL REFERENCES scm.suppliers(id) ON DELETE CASCADE,
  category     text NOT NULL CHECK (category IN ('sofa', 'bedframe', 'mattress', 'accessory', 'service')),
  lead_days    integer NOT NULL CHECK (lead_days >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mrp_supplier_category_lead_times
  ON scm.mrp_supplier_category_lead_times (company_id, supplier_id, category);

CREATE INDEX IF NOT EXISTS idx_mrp_supplier_category_lead_times_supplier
  ON scm.mrp_supplier_category_lead_times (company_id, supplier_id);
