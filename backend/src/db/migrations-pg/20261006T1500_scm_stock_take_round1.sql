-- 20261006T1500_scm_stock_take_round1.sql
-- REVERSAL:
--   ALTER TABLE scm.stock_take_lines DROP COLUMN IF EXISTS added_on_count;
--   ALTER TABLE scm.stock_takes DROP COLUMN IF EXISTS nonzero_only;
--   ALTER TABLE scm.stock_takes DROP COLUMN IF EXISTS assignee_staff_ids;
--   (assignee_staff_id is untouched and still holds the first assignee, so
--   dropping the array loses only the 2nd..Nth names.)
--
-- 白话。盘点第一轮（老板 2026-10-06）：
--   · 两三个人一起点货 → 一张盘点单可以记多个 assignee。assignee 只是记录，
--     不再决定谁能过账（差异超标仍要主管）。
--   · 「只列有库存的 SKU」可以跟 Category / 前缀一起用 → 记下这张单是不是这样建的。
--   · 盘点时发现系统没有、现场有的货 → Add line；标记这一行是点货时加的。
--
-- assignee_staff_ids holds EVERY counter; assignee_staff_id stays the first one
-- so readers that only know the single column (list, PDF, older builds during
-- the deploy window) keep a name. Existing takes (3 OPEN, 1 CANCELLED on
-- 2026-10-06) are backfilled from the single column.

ALTER TABLE scm.stock_takes
  ADD COLUMN IF NOT EXISTS assignee_staff_ids uuid[] NOT NULL DEFAULT '{}';

UPDATE scm.stock_takes
   SET assignee_staff_ids = ARRAY[assignee_staff_id]
 WHERE assignee_staff_id IS NOT NULL
   AND cardinality(assignee_staff_ids) = 0;

ALTER TABLE scm.stock_takes
  ADD COLUMN IF NOT EXISTS nonzero_only boolean NOT NULL DEFAULT false;

ALTER TABLE scm.stock_take_lines
  ADD COLUMN IF NOT EXISTS added_on_count boolean NOT NULL DEFAULT false;
