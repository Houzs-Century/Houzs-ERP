-- Restore NOT-NULL column defaults on sales_reps that were dropped by the
-- D1->PG load. The auto-create path (syncSalesRepFromUser / autoBackfillSalesReps)
-- inserts only (code,name,email,user_id,status) and relies on column defaults for
-- the rest. is_admin + commission_min_rate are NOT NULL with no default in PG, so
-- that INSERT threw -> GET /api/sales-team/reps returned 500 (Sales Team + org
-- chart broken) once Sales-department users needed backfill. PG-only fix (D1
-- keeps its original defaults); idempotent.
ALTER TABLE sales_reps ALTER COLUMN is_admin SET DEFAULT 0;
ALTER TABLE sales_reps ALTER COLUMN commission_min_rate SET DEFAULT 0;
