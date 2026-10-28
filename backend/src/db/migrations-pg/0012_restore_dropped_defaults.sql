-- Systematic fix: restore NOT-NULL column defaults that the D1->Postgres load
-- dropped. App INSERTs omit these (relying on the default), so a missing default
-- throws on insert -> the "Something went wrong / 500" class (sales_reps.is_admin
-- was one instance). Values below are the EXACT D1 originals (from schema.sql /
-- migrations). Idempotent; additive (SET DEFAULT only — existing rows untouched).
ALTER TABLE users               ALTER COLUMN points_balance   SET DEFAULT 0;
ALTER TABLE users               ALTER COLUMN gifting_balance  SET DEFAULT 0;
ALTER TABLE users               ALTER COLUMN current_streak   SET DEFAULT 0;
ALTER TABLE sales_positions     ALTER COLUMN active           SET DEFAULT 1;
ALTER TABLE sales_positions     ALTER COLUMN level            SET DEFAULT 20;
ALTER TABLE sales_positions     ALTER COLUMN sort_order       SET DEFAULT 0;
ALTER TABLE suppliers           ALTER COLUMN active           SET DEFAULT 1;
ALTER TABLE warehouses          ALTER COLUMN is_active        SET DEFAULT 1;
ALTER TABLE trips               ALTER COLUMN is_outsourced    SET DEFAULT 0;
ALTER TABLE trip_proposal_trips ALTER COLUMN is_outsourced    SET DEFAULT 0;
ALTER TABLE user_streak_weeks   ALTER COLUMN qualified        SET DEFAULT 0;
ALTER TABLE user_streak_weeks   ALTER COLUMN upvotes_count    SET DEFAULT 0;
