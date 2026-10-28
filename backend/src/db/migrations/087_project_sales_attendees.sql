-- 087_project_sales_attendees.sql
--
-- Sales people attending a project (decided 2026-06-04).
--
-- Projects already carry a single `pic_id` (the User who owns the
-- project). Separately, an event can have N sales reps physically
-- attending on-site to handle the brand's booth, customer-facing
-- demos, etc. The boss wants this list visible above the project
-- Chat, beside the PIC.
--
-- Sales reps live in the `sales_reps` master table (mig 067), not
-- in `users`. A rep may or may not have a workspace login, but the
-- attendee list is curated from the rep master so the field stays
-- meaningful for office-only reps too.

CREATE TABLE IF NOT EXISTS project_sales_attendees (
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sales_rep_id INTEGER NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  created_by   INTEGER,
  PRIMARY KEY (project_id, sales_rep_id)
);

CREATE INDEX IF NOT EXISTS idx_project_sales_attendees_rep
  ON project_sales_attendees(sales_rep_id);
