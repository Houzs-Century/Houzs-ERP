-- 074_assr_v31_stages.sql
--
-- ASSR/QMS v3.1 — Phase A: 9-stage workflow + per-stage lifecycle.
--
-- The legacy 6-stage enum (registration / triage / action / logistics /
-- resolution / closed) collapsed inspection into the catch-all "action"
-- stage and bundled all pickup / supplier-handover / ready / delivery
-- moves into a single "logistics" stage. v3.1 splits that out into 9
-- explicit stages so SLAs can be tracked per-step.
--
-- Old → new mapping:
--   registration → pending_review
--   triage       → under_verification
--   action       → pending_solution
--   logistics    → pending_item_pickup
--   resolution   → pending_delivery_service
--   closed       → completed
--
-- The stage column carries a CHECK constraint, and SQLite can't ALTER
-- a CHECK in place, so the table is rebuilt (same pattern as mig 036
-- did for projects).
--
-- New columns added in this migration:
--   stage_entered_at      — UTC ts when the case entered its current stage
--   stage_target_days     — snapshot of target at entry (Phase B portal fills this)
--   inspection_result     — pass / fail / na (Stage 4)
--   email_for_survey      — separate CSAT recipient (proposal §14)
--   lead_time_profile_id  — FK to assr_lead_time_profiles (Phase B)
--
-- New table:
--   assr_stage_history    — per-stage lifecycle: entered_at, exited_at,
--                           target_days, status, skipped, alerts_fired.

-- 1) Drop all indexes that reference assr_cases. SQLite refuses to
--    DROP a table that has indexes on it.
DROP INDEX IF EXISTS idx_assr_stage;
DROP INDEX IF EXISTS idx_assr_assigned;
DROP INDEX IF EXISTS idx_assr_status;
DROP INDEX IF EXISTS idx_assr_deadline;
DROP INDEX IF EXISTS idx_assr_approved_by;
DROP INDEX IF EXISTS idx_assr_ncr;
DROP INDEX IF EXISTS idx_assr_cases_customer;
DROP INDEX IF EXISTS idx_assr_cases_archived;
DROP INDEX IF EXISTS idx_assr_customer_email;
DROP INDEX IF EXISTS idx_assr_creditor_code;
DROP INDEX IF EXISTS idx_assr_supplier_pickup;
DROP INDEX IF EXISTS idx_assr_items_ready;
DROP INDEX IF EXISTS idx_assr_stage_changed;

-- 2) Rebuild assr_cases with the widened stage CHECK and the new
--    columns. Column order matches the historical accretion (mig 010 →
--    064) plus the v3.1 columns appended at the end.
CREATE TABLE assr_cases_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assr_no TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'Open',
  doc_no TEXT NOT NULL,
  complained_date TEXT,
  customer_name TEXT,
  phone TEXT,
  location TEXT,
  sales_agent TEXT,
  item_code TEXT,
  complaint_issue TEXT,
  action_remark TEXT,
  service_category TEXT,
  completion_date TEXT,
  po_no TEXT,
  addr1 TEXT,
  addr2 TEXT,
  addr3 TEXT,
  addr4 TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  stage TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (stage IN (
      'pending_review',
      'under_verification',
      'pending_solution',
      'pending_inspection',
      'pending_item_pickup',
      'pending_supplier_pickup',
      'pending_item_ready',
      'pending_delivery_service',
      'completed'
    )),
  resolution_method TEXT
    CHECK (resolution_method IS NULL OR resolution_method IN (
      'replace_unit','supplier_repair','field_service_own','field_service_supplier','return_visit'
    )),
  issue_category TEXT,
  priority TEXT DEFAULT 'normal'
    CHECK (priority IN ('low','normal','high','urgent')),
  assigned_to INTEGER,
  ref_no TEXT,
  delivery_order TEXT,
  do_date TEXT,
  closed_at TEXT,
  created_by INTEGER,
  satisfaction_rating INTEGER,
  satisfaction_notes TEXT,
  approved_by INTEGER,
  approved_at TEXT,
  quality_review_passed INTEGER,
  ncr_category TEXT,
  po_amount REAL,
  supplier_invoice_ref TEXT,
  cost_notes TEXT,
  sla_hours INTEGER,
  deadline_at TEXT,
  escalated_at TEXT,
  customer_id INTEGER,
  archived_at TEXT,
  archived_by INTEGER,
  customer_email TEXT,
  creditor_code TEXT,
  customer_amount REAL,
  supplier_pickup_at TEXT,
  items_ready_at TEXT,
  stage_changed_at TEXT,
  -- v3.1 additions
  stage_entered_at TEXT,
  stage_target_days REAL,
  inspection_result TEXT
    CHECK (inspection_result IS NULL OR inspection_result IN ('pass','fail','na')),
  email_for_survey TEXT,
  lead_time_profile_id INTEGER
);

-- 3) Copy rows, mapping the legacy stage values to the new vocabulary.
INSERT INTO assr_cases_new (
  id, assr_no, status, doc_no, complained_date, customer_name, phone, location,
  sales_agent, item_code, complaint_issue, action_remark, service_category,
  completion_date, po_no, addr1, addr2, addr3, addr4, created_at, updated_at,
  stage, resolution_method, issue_category, priority, assigned_to, ref_no,
  delivery_order, do_date, closed_at, created_by, satisfaction_rating,
  satisfaction_notes, approved_by, approved_at, quality_review_passed,
  ncr_category, po_amount, supplier_invoice_ref, cost_notes, sla_hours,
  deadline_at, escalated_at, customer_id, archived_at, archived_by,
  customer_email, creditor_code, customer_amount, supplier_pickup_at,
  items_ready_at, stage_changed_at,
  stage_entered_at, stage_target_days, inspection_result,
  email_for_survey, lead_time_profile_id
)
SELECT
  id, assr_no, status, doc_no, complained_date, customer_name, phone, location,
  sales_agent, item_code, complaint_issue, action_remark, service_category,
  completion_date, po_no, addr1, addr2, addr3, addr4, created_at, updated_at,
  CASE stage
    WHEN 'registration' THEN 'pending_review'
    WHEN 'triage'       THEN 'under_verification'
    WHEN 'action'       THEN 'pending_solution'
    WHEN 'logistics'    THEN 'pending_item_pickup'
    WHEN 'resolution'   THEN 'pending_delivery_service'
    WHEN 'closed'       THEN 'completed'
    ELSE 'pending_review'
  END AS stage,
  resolution_method, issue_category, priority, assigned_to, ref_no,
  delivery_order, do_date, closed_at, created_by, satisfaction_rating,
  satisfaction_notes, approved_by, approved_at, quality_review_passed,
  ncr_category, po_amount, supplier_invoice_ref, cost_notes, sla_hours,
  deadline_at, escalated_at, customer_id, archived_at, archived_by,
  customer_email, creditor_code, customer_amount, supplier_pickup_at,
  items_ready_at, stage_changed_at,
  -- stage_entered_at seeds from stage_changed_at (mig 064) when present,
  -- falling back to the case's created_at so we always have a value.
  COALESCE(stage_changed_at, created_at) AS stage_entered_at,
  NULL AS stage_target_days,
  NULL AS inspection_result,
  NULL AS email_for_survey,
  NULL AS lead_time_profile_id
FROM assr_cases;

DROP TABLE assr_cases;
ALTER TABLE assr_cases_new RENAME TO assr_cases;

-- 4) Recreate every index that pointed at assr_cases. Same names as
--    the migrations that originally created them so future grep keeps
--    working.
CREATE INDEX IF NOT EXISTS idx_assr_stage           ON assr_cases(stage);
CREATE INDEX IF NOT EXISTS idx_assr_assigned        ON assr_cases(assigned_to);
CREATE INDEX IF NOT EXISTS idx_assr_status          ON assr_cases(status);
CREATE INDEX IF NOT EXISTS idx_assr_deadline        ON assr_cases(deadline_at);
CREATE INDEX IF NOT EXISTS idx_assr_approved_by     ON assr_cases(approved_by);
CREATE INDEX IF NOT EXISTS idx_assr_ncr             ON assr_cases(ncr_category);
CREATE INDEX IF NOT EXISTS idx_assr_cases_customer  ON assr_cases(customer_id);
CREATE INDEX IF NOT EXISTS idx_assr_cases_archived  ON assr_cases(archived_at);
CREATE INDEX IF NOT EXISTS idx_assr_customer_email  ON assr_cases(customer_email);
CREATE INDEX IF NOT EXISTS idx_assr_creditor_code   ON assr_cases(creditor_code);
CREATE INDEX IF NOT EXISTS idx_assr_supplier_pickup ON assr_cases(supplier_pickup_at);
CREATE INDEX IF NOT EXISTS idx_assr_items_ready     ON assr_cases(items_ready_at);
CREATE INDEX IF NOT EXISTS idx_assr_stage_changed   ON assr_cases(stage_changed_at);
CREATE INDEX IF NOT EXISTS idx_assr_stage_entered   ON assr_cases(stage_entered_at);
CREATE INDEX IF NOT EXISTS idx_assr_lead_time_prof  ON assr_cases(lead_time_profile_id);

-- 5) Rewrite any historical 'stage_change' activity rows so their
--    from_value / to_value reflect the new stage vocabulary.
--    The Service Log timeline reads these values directly.
UPDATE assr_activity
   SET from_value = CASE from_value
     WHEN 'registration' THEN 'pending_review'
     WHEN 'triage'       THEN 'under_verification'
     WHEN 'action'       THEN 'pending_solution'
     WHEN 'logistics'    THEN 'pending_item_pickup'
     WHEN 'resolution'   THEN 'pending_delivery_service'
     WHEN 'closed'       THEN 'completed'
     ELSE from_value
   END
 WHERE action = 'stage_change' AND from_value IS NOT NULL;

UPDATE assr_activity
   SET to_value = CASE to_value
     WHEN 'registration' THEN 'pending_review'
     WHEN 'triage'       THEN 'under_verification'
     WHEN 'action'       THEN 'pending_solution'
     WHEN 'logistics'    THEN 'pending_item_pickup'
     WHEN 'resolution'   THEN 'pending_delivery_service'
     WHEN 'closed'       THEN 'completed'
     ELSE to_value
   END
 WHERE action = 'stage_change' AND to_value IS NOT NULL;

-- 6) Per-stage lifecycle table. One row per (case, stage) — closed
--    rows have exited_at set; the open row for a case is exited_at IS NULL.
CREATE TABLE assr_stage_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assr_id INTEGER NOT NULL REFERENCES assr_cases(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  entered_at TEXT NOT NULL DEFAULT (datetime('now')),
  exited_at TEXT,
  target_days REAL,
  status TEXT,            -- 'green' | 'amber' | 'red' — computed by alert engine
  skipped INTEGER NOT NULL DEFAULT 0,
  skip_reason TEXT,
  alerts_fired INTEGER NOT NULL DEFAULT 0,
  snoozes_applied INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_assr_stage_history_case  ON assr_stage_history(assr_id);
CREATE INDEX idx_assr_stage_history_open  ON assr_stage_history(assr_id, exited_at);

-- 7) Seed one open history row per case for its current stage so the
--    Workflow Progress Tracker has data to render on day 1.
INSERT INTO assr_stage_history (assr_id, stage, entered_at)
SELECT id, stage, stage_entered_at FROM assr_cases;
