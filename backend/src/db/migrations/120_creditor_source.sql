-- D1 test mirror of migrations-pg/0115_creditor_source.sql.
-- 'manual' = staff-picked creditor, shielded from auto re-resolution.
ALTER TABLE assr_cases ADD COLUMN creditor_source TEXT;
