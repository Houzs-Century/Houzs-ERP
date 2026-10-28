-- 083_project_phase_helpers.sql
--
-- Per-phase crew helpers on projects (decided 2026-05-28).
--
-- Projects already carry one driver per phase (setup_driver_user_id /
-- dismantle_driver_user_id) but no helpers. The trips table carries
-- driver + helper_1 + helper_2 + helper_outsourced, so a setup-trip
-- created later cannot inherit the planned crew because the project
-- never had it.
--
-- Mirror the trip schema so trip-link can copy the crew across, and
-- so the Driver App can show the right phase brief to each helper.
--
-- All six columns nullable / default 0: existing projects keep the
-- driver-only assignment they had pre-083.

ALTER TABLE projects ADD COLUMN setup_helper_1_id           INTEGER REFERENCES users(id);
ALTER TABLE projects ADD COLUMN setup_helper_2_id           INTEGER REFERENCES users(id);
ALTER TABLE projects ADD COLUMN setup_helper_outsourced     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN dismantle_helper_1_id       INTEGER REFERENCES users(id);
ALTER TABLE projects ADD COLUMN dismantle_helper_2_id       INTEGER REFERENCES users(id);
ALTER TABLE projects ADD COLUMN dismantle_helper_outsourced INTEGER NOT NULL DEFAULT 0;
