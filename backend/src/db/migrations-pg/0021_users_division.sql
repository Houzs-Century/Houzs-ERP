-- Org-chart divisions: a free-text sub-grouping within a department.
--
-- Drives the columns inside each department box on the org chart (e.g. Sales
-- split into 5 divisions). Nullable — members without a division fall into the
-- department's default column. Super-admin editable from the chart.
--
-- Idempotent: applied to the live DB on deploy by pg-migrate.mjs.
ALTER TABLE users ADD COLUMN IF NOT EXISTS division text;
