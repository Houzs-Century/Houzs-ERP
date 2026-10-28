-- 024_pms_notion_parity.sql
-- Closes gaps between our PMS and the team's existing Notion workflow:
--
--   • A separate setup/dismantle window (with times, independent of the
--     customer-facing event date range)
--   • Driver + lorry tagged directly on the project for each phase
--   • Attachments carry the uploader's ROLE (sales / driver / design /
--     office) so sales vs logistics cross-checks are legible
--   • Defect items become structured rows per phase, not just photos
--   • Sales reports get their own first-class section
--   • Checklist items gain a rejection/amendment loop with comments —
--     the design-review cycle Notion captured via narrative
--
-- All changes are additive; existing rows continue to work unchanged.

-- ── Projects: logistics schedule + crew ───────────────────────
ALTER TABLE projects ADD COLUMN setup_start_at       TEXT;     -- ISO datetime, "2025-08-25T23:00"
ALTER TABLE projects ADD COLUMN setup_end_at         TEXT;
ALTER TABLE projects ADD COLUMN dismantle_start_at   TEXT;
ALTER TABLE projects ADD COLUMN dismantle_end_at     TEXT;
ALTER TABLE projects ADD COLUMN setup_driver_user_id INTEGER;  -- → users.id
ALTER TABLE projects ADD COLUMN setup_lorry_id       INTEGER;  -- → lorries.id
ALTER TABLE projects ADD COLUMN dismantle_driver_user_id INTEGER;
ALTER TABLE projects ADD COLUMN dismantle_lorry_id   INTEGER;

-- Optional warning banner ("⚠️ Amend after confirmation" on the Notion page).
ALTER TABLE projects ADD COLUMN banner_message TEXT;
ALTER TABLE projects ADD COLUMN banner_tone    TEXT;           -- 'info' | 'warning' | 'error'

-- ── Attachments: role tagging ─────────────────────────────────
-- Four roles loosely align with the emoji scheme the Notion page used:
--   💻 design | 🚛 driver | 💵 sales | 🧾 office
-- Legacy rows leave this NULL — displayed as "—" in the UI.
ALTER TABLE project_attachments ADD COLUMN uploaded_by_role TEXT;
CREATE INDEX IF NOT EXISTS idx_pa_role ON project_attachments(project_id, uploaded_by_role);

-- ── Defect items ──────────────────────────────────────────────
-- Sales and logistics each keep their own list (that's the point — they
-- cross-check each other). Schema allows an optional ASSR link for the
-- case where a customer later complains about the same damaged unit.

CREATE TABLE IF NOT EXISTS project_defects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('setup', 'dismantle')),
  reported_by_role TEXT NOT NULL CHECK (reported_by_role IN ('sales', 'logistic')),
  item_code TEXT,
  item_description TEXT,
  size TEXT,
  quantity INTEGER DEFAULT 1,
  reason TEXT,
  photo_r2_key TEXT,                 -- optional single photo; richer media goes to attachments
  reported_by INTEGER,               -- users.id
  reported_at TEXT DEFAULT (datetime('now')),
  resolved INTEGER DEFAULT 0,
  resolved_notes TEXT,
  linked_assr_id INTEGER,            -- optional ASSR case link
  archived_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (linked_assr_id) REFERENCES assr_cases(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_pd_project ON project_defects(project_id, phase);

-- ── Sales reports ─────────────────────────────────────────────
-- Intentionally simple. One project can have multiple reports (e.g. daily
-- sales during the event). When a new report is saved, the caller *may*
-- roll the sum into project_finance.total_sales — done at the service
-- layer, not with a trigger, so we can choose whether to auto-sync.

CREATE TABLE IF NOT EXISTS project_sales_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  title TEXT,                         -- "Day 1", "Final", etc.
  sales_amount REAL,                  -- RM
  period_start TEXT,                  -- optional date
  period_end   TEXT,
  r2_key TEXT,                        -- optional attached report image/PDF
  file_name TEXT,
  mime_type TEXT,
  uploaded_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  archived_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_psr_project ON project_sales_reports(project_id);

-- ── Checklist: rejection / amendment loop ─────────────────────
-- `status` stays as the headline state (pending/done/na/blocked).
-- `review_status` layers on top: NULL for items that haven't entered
-- review, 'pending_review' once someone submits for approval,
-- 'rejected' if a reviewer pushes back, 'amended' if resubmitted after
-- rejection, 'approved' on sign-off. `rejection_reason` stores the
-- latest reason; full history lives in project_checklist_comments.

ALTER TABLE project_checklist ADD COLUMN review_status TEXT;
ALTER TABLE project_checklist ADD COLUMN rejection_reason TEXT;

CREATE TABLE IF NOT EXISTS project_checklist_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('note','submit','reject','amend','approve')),
  body TEXT,
  user_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (item_id) REFERENCES project_checklist(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pcc_item ON project_checklist_comments(item_id, created_at);
