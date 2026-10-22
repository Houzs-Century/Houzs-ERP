-- 20261006T1700_scm_stock_take_line_rack.sql
-- REVERSAL:
--   ALTER TABLE scm.stock_take_lines DROP COLUMN IF EXISTS rack_id;
--   (Racks already moved by a posted take stay where they were put — the rack
--   ledger rows and their movements are history, not derived from this column.)
--
-- 白话。盘点第二轮（老板 2026-10-06）：点货时在纸上写这件货实际在哪个 rack，
-- 拍照上传或手动选，记在盘点行上；Post 的时候货架板（Racks & Bins）跟着搬过去，
-- 让货架记录和现场一致。
--
-- The rack the counter found the goods on. Must be a rack of the take's own
-- warehouse (enforced in the route — a rack is per warehouse record, so per
-- company). ON DELETE SET NULL: deleting a rack must not delete a count.

ALTER TABLE scm.stock_take_lines
  ADD COLUMN IF NOT EXISTS rack_id uuid REFERENCES scm.warehouse_racks(id) ON DELETE SET NULL;
