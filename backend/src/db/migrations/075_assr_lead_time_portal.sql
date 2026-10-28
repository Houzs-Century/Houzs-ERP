-- 075_assr_lead_time_portal.sql
--
-- ASSR/QMS v3.1 — Phase B: Lead Time Portal.
--
-- Manager-editable per-stage lead time targets with seasonal profiles
-- (Normal / Peak / Custom) and a full audit trail of amendments.
-- Without this, stage targets are hardcoded in services/assr.ts; with
-- it, the active profile's stage_targets drive the snapshot taken on
-- every stage transition (and feeds the alert engine in Phase C).
--
-- Schema:
--   assr_lead_time_profiles      — Named profile rows; exactly one is_active
--   assr_stage_targets           — One row per (profile, stage) with target_days
--   assr_lead_time_amendments    — Append-only audit of every target change

CREATE TABLE assr_lead_time_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Partial unique index would enforce "exactly one active" at the DB
-- level; D1's SQLite supports it but the route layer already ensures
-- it on writes so we keep the schema simple. The unique INDEX-on-name
-- prevents accidental dup profiles.

CREATE TABLE assr_stage_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES assr_lead_time_profiles(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  target_days REAL NOT NULL,
  UNIQUE(profile_id, stage)
);
CREATE INDEX idx_assr_stage_targets_profile ON assr_stage_targets(profile_id);

CREATE TABLE assr_lead_time_amendments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES assr_lead_time_profiles(id),
  stage TEXT NOT NULL,
  before_days REAL,
  after_days REAL NOT NULL,
  reason TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_assr_lt_amend_profile ON assr_lead_time_amendments(profile_id, created_at);

-- ── Seed Normal + Peak profiles per proposal §8.1 ──────────────────
-- Normal: 21 days end-to-end. Peak: 28 days end-to-end (Hari Raya /
-- CNY / year-end / monsoon).

INSERT INTO assr_lead_time_profiles (name, description, is_active)
VALUES
  ('Normal', 'Default operating conditions — 21 days end-to-end (proposal §8.1).', 1),
  ('Peak',   'Hari Raya / CNY / year-end / monsoon — 28 days end-to-end (proposal §8.1).', 0);

-- Normal profile targets (one INSERT per stage — D1 caps compound
-- SELECTs at 8 terms, and we need 9 stages, so individual inserts
-- are the safe path).
INSERT INTO assr_stage_targets (profile_id, stage, target_days)
SELECT id, 'pending_review', 1.0 FROM assr_lead_time_profiles WHERE name = 'Normal';
INSERT INTO assr_stage_targets (profile_id, stage, target_days)
SELECT id, 'under_verification', 2.0 FROM assr_lead_time_profiles WHERE name = 'Normal';
INSERT INTO assr_stage_targets (profile_id, stage, target_days)
SELECT id, 'pending_solution', 2.0 FROM assr_lead_time_profiles WHERE name = 'Normal';
INSERT INTO assr_stage_targets (profile_id, stage, target_days)
SELECT id, 'pending_inspection', 2.0 FROM assr_lead_time_profiles WHERE name = 'Normal';
INSERT INTO assr_stage_targets (profile_id, stage, target_days)
SELECT id, 'pending_item_pickup', 2.0 FROM assr_lead_time_profiles WHERE name = 'Normal';
INSERT INTO assr_stage_targets (profile_id, stage, target_days)
SELECT id, 'pending_supplier_pickup', 3.0 FROM assr_lead_time_profiles WHERE name = 'Normal';
INSERT INTO assr_stage_targets (profile_id, stage, target_days)
SELECT id, 'pending_item_ready', 5.0 FROM assr_lead_time_profiles WHERE name = 'Normal';
INSERT INTO assr_stage_targets (profile_id, stage, target_days)
SELECT id, 'pending_delivery_service', 4.0 FROM assr_lead_time_profiles WHERE name = 'Normal';
INSERT INTO assr_stage_targets (profile_id, stage, target_days)
SELECT id, 'completed', 0.0 FROM assr_lead_time_profiles WHERE name = 'Normal';

-- Peak profile targets
INSERT INTO assr_stage_targets (profile_id, stage, target_days)
SELECT id, 'pending_review', 1.0 FROM assr_lead_time_profiles WHERE name = 'Peak';
INSERT INTO assr_stage_targets (profile_id, stage, target_days)
SELECT id, 'under_verification', 2.0 FROM assr_lead_time_profiles WHERE name = 'Peak';
INSERT INTO assr_stage_targets (profile_id, stage, target_days)
SELECT id, 'pending_solution', 3.0 FROM assr_lead_time_profiles WHERE name = 'Peak';
INSERT INTO assr_stage_targets (profile_id, stage, target_days)
SELECT id, 'pending_inspection', 3.0 FROM assr_lead_time_profiles WHERE name = 'Peak';
INSERT INTO assr_stage_targets (profile_id, stage, target_days)
SELECT id, 'pending_item_pickup', 3.0 FROM assr_lead_time_profiles WHERE name = 'Peak';
INSERT INTO assr_stage_targets (profile_id, stage, target_days)
SELECT id, 'pending_supplier_pickup', 4.0 FROM assr_lead_time_profiles WHERE name = 'Peak';
INSERT INTO assr_stage_targets (profile_id, stage, target_days)
SELECT id, 'pending_item_ready', 7.0 FROM assr_lead_time_profiles WHERE name = 'Peak';
INSERT INTO assr_stage_targets (profile_id, stage, target_days)
SELECT id, 'pending_delivery_service', 5.0 FROM assr_lead_time_profiles WHERE name = 'Peak';
INSERT INTO assr_stage_targets (profile_id, stage, target_days)
SELECT id, 'completed', 0.0 FROM assr_lead_time_profiles WHERE name = 'Peak';
