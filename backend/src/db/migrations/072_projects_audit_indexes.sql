-- 072_projects_audit_indexes.sql
--
-- Two indexes flagged by the May 2026 PMS production-readiness audit
-- as missing — both today serve their queries via full scans, which
-- is fine at current row counts but degrades as data accumulates.
--
--   project_activity(project_id, created_at)
--     Timeline fetches in the project detail view sort by created_at
--     within a single project_id. Composite covers the WHERE + ORDER.
--
--   project_checklist(project_id, due_date)
--     Overdue-task queries (calendar + reminder cron) filter on
--     project_id then range-scan due_date. Composite avoids the
--     table scan.
--
-- IF NOT EXISTS keeps the migration safe to re-run on partial state.

CREATE INDEX IF NOT EXISTS idx_project_activity_project_created
  ON project_activity(project_id, created_at);

CREATE INDEX IF NOT EXISTS idx_project_checklist_project_due
  ON project_checklist(project_id, due_date);
