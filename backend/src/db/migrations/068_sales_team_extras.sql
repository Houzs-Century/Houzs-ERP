-- 068_sales_team_extras.sql
--
-- Boss's Organisation Chart screen calls for three things mig 067
-- didn't seed:
--   1. NRIC (Malaysian IC number) on the rep — payroll/commission data.
--   2. Secondary upline — some reps report to two seniors (one for
--      sales, one for ops); secondary is optional.
--   3. Per-rep commission tier table + a personal floor rate. The
--      maintenance-page tier list (mig 067) stays as the global
--      default; this lets each rep override with custom thresholds.

ALTER TABLE sales_reps ADD COLUMN nric TEXT;
ALTER TABLE sales_reps ADD COLUMN upline_secondary_id INTEGER
  REFERENCES sales_reps(id) ON DELETE SET NULL;
ALTER TABLE sales_reps ADD COLUMN commission_min_rate REAL NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS sales_rep_commission_tiers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rep_id      INTEGER NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
  threshold   REAL NOT NULL DEFAULT 0,       -- sales threshold in RM (0 = floor)
  rate        REAL NOT NULL DEFAULT 0,       -- percent
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rep_tiers_rep ON sales_rep_commission_tiers(rep_id, sort_order);
