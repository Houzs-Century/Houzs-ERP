-- 0015_checklist_amendments_schema.sql
--
-- Postgres schema delta for the PORTED features from the pre-cutover D1 branch
-- feat/checklist-amendments (D1 migrations 089-101), EXCLUDING roles /
-- page-access (kept from current main per owner steering).
--
-- Every statement is additive + idempotent (IF NOT EXISTS / guarded) so it is
-- safe to apply to the live DB and safe to re-run. Per the mig-0008 gotcha, any
-- column written via the d1-compat shim's datetime('now') is TEXT, never
-- timestamptz. created_at columns populated only by DEFAULT use to_char(now()).
--
-- This file is SCHEMA ONLY. The data seeding from the branch (new checklist
-- rows, role chips, renames, display_mode='documents' flips, the PAYMENT
-- section, review-state clearing) belongs in a SEPARATE numbered data migration
-- (0016) per the repo rule "keep schema and data in separate migrations".

-- ── projects: setup/dismantle crew JSON (D1 mig 097) ──────────
-- JSON-as-text blob: {"drivers":[{name,phone}],"helpers":[...],
-- "lorries":["PLATE"],"outsourced":{enabled,name,phone,plate}}.
-- Stored as text (not jsonb) to match the d1-compat read path and the branch's
-- COALESCE(p.setup_crew,'') IN ('','{}') guards; the detail query is SELECT p.*
-- so the columns surface automatically. PATCH_FIELDS gains setup_crew /
-- dismantle_crew (see backend wiring note).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS setup_crew     text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS dismantle_crew text;

-- ── users: company phone (D1 mig 100) ─────────────────────────
-- Second phone line for drivers/helpers. Personal line stays in users.phone
-- (added by PG mig 0013); this is the company line, reference-only for now.
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_phone text;

-- ── lorries: fleet + compliance columns (D1 migs 005/009) ─────
-- These landed in D1 long before the fork but were NOT carried into the PG
-- cutover baseline (baseline lorries = id/plate/size/default_driver_user_id
-- only), yet current-main backend/src/services/fleet.ts already SELECTs and
-- PATCHes them (LORRY_PATCH_FIELDS + getLorryDetail l.*), so fleet endpoints
-- currently fail in prod. Added nullable (can't add NOT NULL to populated rows
-- without a default); is_internal/is_active default to the D1 values.
ALTER TABLE lorries ADD COLUMN IF NOT EXISTS warehouse        text;
ALTER TABLE lorries ADD COLUMN IF NOT EXISTS is_internal      integer NOT NULL DEFAULT 1;
ALTER TABLE lorries ADD COLUMN IF NOT EXISTS is_active        integer NOT NULL DEFAULT 1;
ALTER TABLE lorries ADD COLUMN IF NOT EXISTS model            text;
ALTER TABLE lorries ADD COLUMN IF NOT EXISTS purchase_date    text;
ALTER TABLE lorries ADD COLUMN IF NOT EXISTS capacity_m3      real;
ALTER TABLE lorries ADD COLUMN IF NOT EXISTS capacity_kg      real;
ALTER TABLE lorries ADD COLUMN IF NOT EXISTS road_tax_expiry  text;
ALTER TABLE lorries ADD COLUMN IF NOT EXISTS insurance_expiry text;
ALTER TABLE lorries ADD COLUMN IF NOT EXISTS puspakom_expiry  text;
ALTER TABLE lorries ADD COLUMN IF NOT EXISTS status           text DEFAULT 'active';
ALTER TABLE lorries ADD COLUMN IF NOT EXISTS created_at       text DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS');

-- ── project_checklist + template_items: pill columns (D1 mig 090) ─
-- Payment/deposit multi-state pills. pill_kind = 'rental_payment' |
-- 'security_deposit'; pill_value = current choice. When set, the UI renders
-- pills and forces status='na' (excluded from progress). The other branch
-- checklist columns (role_label, crew_visible, review_status, rejection_reason)
-- already exist in the PG baseline (D1 migs 085/086/024 folded into baseline) —
-- nothing to add for those.
ALTER TABLE project_checklist                ADD COLUMN IF NOT EXISTS pill_kind  text;
ALTER TABLE project_checklist                ADD COLUMN IF NOT EXISTS pill_value text;
ALTER TABLE project_checklist_template_items ADD COLUMN IF NOT EXISTS pill_kind  text;
ALTER TABLE project_checklist_template_items ADD COLUMN IF NOT EXISTS pill_value text;

-- ── sales_entry_activity: append-only edit history (D1 mig 101) ─
-- Was never carried into the PG baseline or the d1 dump, yet PG mig
-- 0002_indexes.sql line 151 already creates idx_sales_entry_activity_entry on
-- it (the index was generated from a D1 export that HAD the table). Create the
-- table so that index — and this feature — work. created_at is TEXT (shim
-- writes datetime('now')); id is bigint identity (serial-equivalent), matching
-- the D1 INTEGER PRIMARY KEY AUTOINCREMENT.
CREATE TABLE IF NOT EXISTS sales_entry_activity (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id   integer NOT NULL,
  user_id    integer,
  action     text NOT NULL,
  note       text,
  created_at text DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')
);

-- Mirrors the index in 0002_indexes.sql (re-declared IF NOT EXISTS so this file
-- is self-contained and order-independent).
CREATE INDEX IF NOT EXISTS idx_sales_entry_activity_entry
  ON sales_entry_activity(entry_id, created_at);
