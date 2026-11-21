-- 20261122T0700_scm_grn_item_version.sql
--
-- A goods-receipt line carries a version, so two people editing one line cannot both move its stock.
--
-- THE BUG. PATCH /grns/:id/items/:itemId read the line, computed the stock delta from the qty it read, then wrote the
--   line with no condition. Two editors both read qty 10; one saved 6 (stock OUT 4), the other 8 (stock OUT 2). Both
--   writes landed and both stock moves landed: the line said 8 while the shelf had lost 6.
--
-- THE FIX. The edit writes version = read + 1 WHERE version = read AND qty_accepted = read. The second save matches
--   no row, moves no stock, writes no AutoCount outbox row, and is told to reload. Only the line edit compares it;
--   other writers of grn_items leave it alone, which is why the route also compares qty_accepted.
--
-- Safe: adding a NOT NULL column with a constant default is metadata-only on PostgreSQL 11+ (no table rewrite).
--   No view selects grn_items.* into a fixed column list that this would change.
--
-- REVERSAL: ALTER TABLE scm.grn_items DROP COLUMN IF EXISTS version; (revert the route that selects it first).
-- Verified against: Staging Migrations on the branch (cited in the PR).

ALTER TABLE scm.grn_items ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
