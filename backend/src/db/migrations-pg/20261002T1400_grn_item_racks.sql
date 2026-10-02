-- 20261002T1400_grn_item_racks.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.grn_item_racks;
--   Revert the code first: scm/lib/grn-line-racks.ts (GET /grns/:id/racks,
--   PUT /grns/:id/items/:itemId/racks, the post check) and grn-rack-sync.ts
--   (placement reads this table). Rows only plan where a DRAFT line's goods go;
--   what was actually placed lives in scm.warehouse_rack_items, keyed by
--   source_grn_id, which this drop does not touch. A dropped split falls back
--   to the line's single rack_id, which a split sets to NULL when it uses more
--   than one rack — so those lines would post unplaced, not misplaced.
--   GRANTS: none to re-apply — it rides the scm schema's default privileges
--   (service_role), like scm.acc_credit_note_allocations.
--
-- WHAT THIS CHANGES: one new empty table (its UNIQUE key is the grn_item_id
--   lookup index); nothing altered.
--
-- 白话（老板 2026-10-02：同一个产品一次到货要拆开放好几个货架，「很多」）。以前一行
-- 收货只能记一个货架。这张表让一行分到几个货架，每个货架记数量，例如 6 张放 L3.1、
-- 4 张放 L3.2。草稿时仓库扫货架填好；采购确认入库时按这里分别上架，数量必须加起来
-- 等于收货数量才能确认。

CREATE TABLE IF NOT EXISTS scm.grn_item_racks (
  id           uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id   bigint      NOT NULL,
  grn_item_id  uuid        NOT NULL REFERENCES scm.grn_items(id) ON DELETE CASCADE,
  rack_id      uuid        NOT NULL REFERENCES scm.warehouse_racks(id) ON DELETE RESTRICT,
  qty          integer     NOT NULL CHECK (qty > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  CONSTRAINT grn_item_racks_one_row_per_rack UNIQUE (grn_item_id, rack_id)
);
