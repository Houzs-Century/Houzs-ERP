-- 112_assr_assigned_to_2.sql
-- D1 test mirror of migrations-pg/0075 — co-assignee on service cases.
ALTER TABLE assr_cases ADD COLUMN assigned_to_2 INTEGER;
