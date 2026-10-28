-- 0202_scm_lorry_compliance_vault.sql — Fleet Maintenance & Compliance, Phase 1.
--
-- ⚠️ RE-CHECK NUMBER AT MERGE. 0200/0201 were taken by parallel branches; 0202
-- was the next free number when this file was written. Migrations run in prod on
-- every deploy and DUPLICATE numbers wedge the runner (pg-migrate keys on the
-- FULL filename, so a gap is harmless — a collision is not). Re-list the tree at
-- merge and renumber to highest-on-main + 1 if 0202 was taken in the meantime.
--
-- WHAT THIS ADDS (schema only — no seed data; the owner backfills the vault with
-- backend/scripts/seed-fleet-maintenance.mjs):
--   scm.lorry_compliance_documents — the compliance VAULT with true renewal
--   history. One row per issued/renewed document; to RENEW you INSERT a new row
--   (the prior row survives as history), never UPDATE an expiry. The current
--   document per (lorry, doc_type) is the latest-expiring row.
--
-- WHY THIS SITS ON scm.lorries, NOT A NEW MASTER. scm.lorries (mig 0053) is THE
-- fleet master — plate UNIQUE, referenced by scm.trips.lorry_id and
-- scm.delivery_order_crew.lorry_id, and the /scm/fleet page reads it via
-- /api/scm/lorries. mig 0055 already DROPPED a duplicate public.lorries once;
-- this module does not repeat that. The genuinely-new piece is the renewal
-- history + the document types the flat columns can't hold (APAD, cross-border,
-- PUSPAKOM result/reinspection). The three flat expiry columns already on
-- scm.lorries (road_tax_expiry / insurance_expiry / puspakom_expiry, mig 0121)
-- are KEPT as the denormalized "current" value — the compliance-append route
-- syncs them from the latest vault row so the existing Fleet compliance strip
-- keeps working. Derived status also reuses scm.lorry_maintenance (out-of-
-- service windows) and scm.lorry_service_records (odometer + next service).
--
-- COMPANY SCOPE — matches scm.lorry_service_records (mig 0121), NOT a hard scope.
-- The fleet is UNIFIED across companies (scm.lorries has no company_id;
-- lorries.ts: "one shared lorry fleet across ALL companies"). So company_id here
-- is STAMPED on insert but NOT used to scope reads — a lorry's compliance must
-- be visible wherever the lorry is. Nullable + no FK, exactly like
-- lorry_service_records.company_id.
--
-- HOUSE STYLE. Additive, idempotent (IF NOT EXISTS), scm-schema-qualified.
-- pg-migrate runs the whole file in ONE transaction.

SET search_path = scm, public;

CREATE TABLE IF NOT EXISTS scm.lorry_compliance_documents (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stamped with the active company on insert; NOT read for scoping (unified
  -- fleet — see the header). Nullable + no FK, mirroring lorry_service_records.
  company_id             BIGINT,
  lorry_id               UUID NOT NULL REFERENCES scm.lorries(id) ON DELETE CASCADE,
  -- PUSPAKOM | ROAD_TAX | INSURANCE | APAD | CROSS_BORDER. CHECK not enum so
  -- adding a kind later is an app change. Mirrors services/fleet-status.ts.
  doc_type               TEXT NOT NULL CHECK (doc_type IN ('PUSPAKOM','ROAD_TAX','INSURANCE','APAD','CROSS_BORDER')),
  document_ref           TEXT,
  issue_date             DATE,
  expiry_date            DATE,
  -- Money is BIGINT cents (repo convention: *_centi), never a float.
  cost_centi             BIGINT CHECK (cost_centi IS NULL OR cost_centi >= 0),
  -- Who owns the renewal (person / department).
  owner                  TEXT,
  -- PUSPAKOM only: PASS | FAIL. A FAIL grounds the lorry (COMPLIANCE_BLOCKED)
  -- until a fresh PASS row is appended.
  result                 TEXT CHECK (result IS NULL OR result IN ('PASS','FAIL')),
  -- PUSPAKOM FAIL: the deadline to re-present the vehicle for reinspection.
  reinspection_deadline  DATE,
  notes                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The real person (public.users.id, bigint), not the pinned scm.staff system
  -- uuid — same choice and reasoning as lorry_service_records.created_by.
  created_by             BIGINT
);

-- The hot query: current document + renewal history per (lorry, type), newest
-- expiry first.
CREATE INDEX IF NOT EXISTS idx_lorry_compliance_lorry_type_expiry
  ON scm.lorry_compliance_documents (lorry_id, doc_type, expiry_date DESC);

-- ── LATER-PHASE SEAMS (documented, not built) ───────────────────────────────
-- deriveVehicleStatus() (services/fleet-status.ts) already accepts openWorkOrder
-- + breakdownActive; the tables that will feed them are NOT created here (no
-- empty prod surface nobody writes):
--   * fleet work orders     -> PLANNED_MAINTENANCE / WAITING_PARTS
--   * fleet breakdown cases -> BREAKDOWN + downtime
-- Phase 1 out-of-service already comes from the EXISTING scm.lorry_maintenance
-- window; service due comes from the EXISTING scm.lorry_service_records
-- odometer + next_service_km/date. See docs/modules/fleet-maintenance.md.
