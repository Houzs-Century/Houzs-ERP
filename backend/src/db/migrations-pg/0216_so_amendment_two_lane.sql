-- 0216_so_amendment_two_lane.sql — the SO Amendment TWO-LANE rework (owner
-- 2026-07-27) + the approver role grants that make it usable.
--
-- THE MODEL. An SO amendment submission is auto-classified (and, when mixed,
-- SPLIT) into two independent approval lanes, each ONE signature that applies
-- immediately:
--   LINES    — product-line changes -> Purchasing (scm.amendment.approve_lines).
--              Applying auto-raises a follow-up row in po_amendments
--              (source_so_amendment_id) which the purchaser CONFIRMS in the PO
--              Amendments module (scm.po_amendment.approve) — their second
--              signature; that confirm re-derives the bound PO via reviseBoundPo.
--   DELIVERY — schedule dates / State / Postcode / City (later: address lines,
--              disposal, transport charges) -> Logistics
--              (scm.amendment.approve_delivery). Never touches a PO.
-- There is NO supplier-confirm step and NO SENT chain on lane rows; legacy
-- (lane IS NULL) rows keep the original two-gate flow and its original keys.
--
-- Houzs conventions (mirror 0080/0192): schema-qualified scm.*; NO inner
-- BEGIN/COMMIT (pg-migrate owns ONE transaction); DO $$ blocks on ONE line;
-- additive + IF NOT EXISTS -> re-run safe.
--
-- ⚠️ MIGRATION NUMBER taken as 0216 at branch time (latest was 0215). Parallel
-- PRs collide on numbers — RE-CHECK and renumber at MERGE by re-listing the tree.
--
-- Apply BEFORE deploying the dependent API code (migrate-before-deploy).

SET search_path = scm, public;

-- (1) Lane on the SO amendment: 'LINES' | 'DELIVERY', NULL = legacy row.
ALTER TABLE scm.so_amendments ADD COLUMN IF NOT EXISTS lane text;
DO $$ BEGIN ALTER TABLE scm.so_amendments ADD CONSTRAINT so_amendments_lane_chk CHECK (lane IS NULL OR lane IN ('LINES','DELIVERY')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- (2) Follow-up linkage on the PO amendment. ON DELETE SET NULL — a purged SO
-- amendment must not take the purchaser's confirmed paper trail with it.
ALTER TABLE scm.po_amendments ADD COLUMN IF NOT EXISTS source_so_amendment_id uuid;
ALTER TABLE scm.po_amendments ADD COLUMN IF NOT EXISTS source_so_amendment_no text;
DO $$ BEGIN ALTER TABLE scm.po_amendments ADD CONSTRAINT po_amendments_source_so_amendment_fk FOREIGN KEY (source_so_amendment_id) REFERENCES scm.so_amendments(id) ON DELETE SET NULL; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_po_amendments_source_so ON scm.po_amendments (source_so_amendment_id);

-- (3) Openness indexes. The original uq_so_amendment_open (one open per SO,
-- any non-terminal status) splits into:
--   * legacy rows (lane IS NULL): unchanged semantics — one open chain per SO;
--   * lane rows: one OPEN (= REQUESTED; SO_APPROVED is their applied terminal)
--     per (so_doc_no, lane).
DROP INDEX IF EXISTS scm.uq_so_amendment_open;
CREATE UNIQUE INDEX IF NOT EXISTS uq_so_amendment_open_legacy ON scm.so_amendments (so_doc_no) WHERE status NOT IN ('SENT','REJECTED') AND lane IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_so_amendment_open_lane ON scm.so_amendments (so_doc_no, lane) WHERE status = 'REQUESTED' AND lane IS NOT NULL;

-- (4) Approver grants — owner 2026-07-27: "purchasing 和 logistic admin 没有
-- 权限 approve". Every live role is is_system=1 (D1->PG conversion) and
-- routes/roles.ts refuses permission edits on system roles, so the Roles UI
-- CANNOT grant these — a migration is the sanctioned channel, and it lands on
-- staging + production alike.
--
-- Targets by NAME (ids drift between environments): 'Purchaser' = the
-- purchasing desk (prod 330 live + 322, a stale 0-user duplicate — inert, and
-- correct-by-accident if ever staffed); 'Logistic' = the logistics desk (prod
-- 323; its users' position is Logistic Admin). Grants:
--   Purchaser -> scm.amendment.approve_lines  (lane signature)
--                + scm.po_amendment.approve   (the follow-up second signature)
--   Logistic  -> scm.amendment.approve_delivery
-- Owner / Super Admin already hold everything via the "*" wildcard.
-- Idempotent: the jsonb union dedupes, so a re-run converges. permissions is a
-- TEXT column holding a JSON array (services/auth.ts parsePermissions); every
-- live row is valid JSON (verified by the diag-role-permissions run 2026-07-27).

-- public. qualified explicitly — roles/users are MAIN-app tables; with
-- search_path = scm, public an unqualified name would bind to a same-named
-- scm table if one ever appears.
UPDATE public.roles SET permissions = (
  SELECT jsonb_agg(DISTINCT k)::text FROM (
    SELECT jsonb_array_elements_text(permissions::jsonb) AS k
    UNION
    SELECT unnest(ARRAY['scm.amendment.approve_lines', 'scm.po_amendment.approve'])
  ) AS u(k)
)
WHERE name = 'Purchaser' AND permissions IS NOT NULL;

UPDATE public.roles SET permissions = (
  SELECT jsonb_agg(DISTINCT k)::text FROM (
    SELECT jsonb_array_elements_text(permissions::jsonb) AS k
    UNION
    SELECT unnest(ARRAY['scm.amendment.approve_delivery'])
  ) AS u(k)
)
WHERE name = 'Logistic' AND permissions IS NOT NULL;
