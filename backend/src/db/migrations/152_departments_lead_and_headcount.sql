-- 152_departments_lead_and_headcount — D1 test mirror of migrations-pg/0331.
-- A department's real lead (lead_user_id, ON DELETE SET NULL) + an optional
-- headcount target. Additive; NULL defaults mean "no lead / no target".

ALTER TABLE departments ADD COLUMN lead_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE departments ADD COLUMN headcount_target INTEGER;
