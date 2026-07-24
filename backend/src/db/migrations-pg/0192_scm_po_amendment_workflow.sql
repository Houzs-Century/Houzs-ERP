-- 0192_scm_po_amendment_workflow.sql — the Purchase Order amendment module.
--
-- A PO amendment lets a purchaser change a Purchase Order (line qty / supplier
-- cost / spec / delivery date, add or remove a line, or the header supplier /
-- delivery / terms) through a single-approver gate. On APPROVE the current PO is
-- snapshotted into scm.po_revisions (already created by mig 0080), the line diffs
-- are applied in place, purchase_orders.revision is bumped, and an
-- AMENDMENT_PO_APPROVED row is written to scm.entity_audit_log (mig 0139).
--
-- This mirrors the SO amendment workflow (mig 0080 so_amendments /
-- so_amendment_lines) but with the SIMPLIFIED status set the owner approved:
-- REQUESTED -> APPROVED, plus REJECTED as the terminal close (reject OR withdraw).
-- There is deliberately NO supplier-pending / two-gate / sent chain here — the PO
-- amendment is one request and one approval.
--
-- Reused, NOT recreated (both from mig 0080): scm.po_revisions (the immutable
-- snapshot table) and scm.purchase_orders.revision (the live counter). This
-- migration adds only the two REQUEST tables + their enum.
--
-- Houzs conventions (mirror 0080_scm_so_amendment_workflow.sql):
--   * schema-qualified to scm.*; SET search_path = scm, public.
--   * NO inner BEGIN/COMMIT — the pg-migrate runner owns ONE transaction.
--   * pg-migrate splits on /;\s*\n/ and does NOT respect $$; every DO $$ ... $$
--     block is therefore written ON ONE LINE (internal ';' space-separated).
--   * Additive + run-once + IF NOT EXISTS -> re-run safe.
--   * company_id is a plain NULLABLE bigint with NO FK / NO NOT-NULL (the
--     companies master is Phase 0f) — matches every amendment table in 0080.
--
-- Apply BEFORE deploying the dependent API code (migrate-before-deploy).
--
-- ⚠️ MIGRATION NUMBER: taken as 0192 at branch time (latest was 0191). Parallel
-- PRs collide on numbers — RE-CHECK and renumber at MERGE by re-listing the tree.

SET search_path = scm, public;

-- Enum — the SIMPLIFIED PO amendment status set (Requested -> Approved, Rejected)
DO $$ BEGIN CREATE TYPE scm.po_amendment_status AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Request tables -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scm.po_amendments (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id                  uuid NOT NULL,
  po_number              text NOT NULL,
  amendment_no           text NOT NULL,
  status                 scm.po_amendment_status NOT NULL DEFAULT 'REQUESTED',
  reason                 text,
  requested_by           uuid,
  approved_by            uuid,
  approved_at            timestamptz,
  rejected_by            uuid,
  rejected_at            timestamptz,
  rejection_reason       text,
  -- How the amendment CLOSED — 'REJECTED' (an approver refused it) vs 'WITHDRAWN'
  -- (its requester pulled it back). Both land on the REJECTED status; this column
  -- is what tells a reader the two apart (mirrors so_amendments.resolution, 0149).
  resolution             text,
  -- Header half of the request (supplier / delivery date / terms changes) + its
  -- before-snapshot. NULL on a line-only amendment (mirrors so_amendments.
  -- header_changes / old_header_snapshot from 0119).
  header_changes         jsonb,
  old_header_snapshot    jsonb,
  -- In-place edit counter (mirror of 0149) — a requester may correct a still-open
  -- request rather than raise a competing one.
  edited_at              timestamptz,
  edit_count             integer NOT NULL DEFAULT 0,
  -- Optimistic-concurrency + apply-lease (mirror so_amendments) so the approve
  -- gate cannot double-apply under a race.
  version                integer NOT NULL DEFAULT 1,
  apply_lease_token      uuid,
  apply_lease_expires_at timestamptz,
  company_id             bigint,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scm.po_amendment_lines (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amendment_id           uuid NOT NULL,
  purchase_order_item_id uuid,
  -- SPEC | QTY | PRICE | DELIVERY | ADD | REMOVE (the change this line requests).
  change_type            text NOT NULL,
  new_material_code      text,
  new_material_name      text,
  new_variants           jsonb,
  new_qty                integer,
  new_unit_price_centi   integer,
  new_delivery_date      date,
  old_snapshot           jsonb,
  company_id             bigint
);

-- Foreign keys (one-line DO guards; ADD CONSTRAINT is not IF-NOT-EXISTS-able) --
DO $$ BEGIN ALTER TABLE scm.po_amendments ADD CONSTRAINT po_amendments_po_id_fk FOREIGN KEY (po_id) REFERENCES scm.purchase_orders(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE scm.po_amendments ADD CONSTRAINT po_amendments_requested_by_fk FOREIGN KEY (requested_by) REFERENCES scm.staff(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE scm.po_amendments ADD CONSTRAINT po_amendments_approved_by_fk FOREIGN KEY (approved_by) REFERENCES scm.staff(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE scm.po_amendments ADD CONSTRAINT po_amendments_rejected_by_fk FOREIGN KEY (rejected_by) REFERENCES scm.staff(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE scm.po_amendment_lines ADD CONSTRAINT po_amendment_lines_amendment_id_fk FOREIGN KEY (amendment_id) REFERENCES scm.po_amendments(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Indexes --------------------------------------------------------------------
-- One OPEN amendment per PO — with the simplified status set, only REQUESTED is
-- open (APPROVED and REJECTED are both terminal). Partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_po_amendment_open ON scm.po_amendments (po_id) WHERE status = 'REQUESTED';
CREATE INDEX IF NOT EXISTS idx_po_amendment_po           ON scm.po_amendments (po_id);
CREATE INDEX IF NOT EXISTS idx_po_amendments_company     ON scm.po_amendments (company_id);
CREATE INDEX IF NOT EXISTS idx_po_amendment_lines_amd    ON scm.po_amendment_lines (amendment_id);
CREATE INDEX IF NOT EXISTS idx_po_amendment_lines_company ON scm.po_amendment_lines (company_id);
