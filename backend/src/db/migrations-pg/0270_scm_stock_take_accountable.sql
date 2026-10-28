-- 0270 — Stock take phase 1: accountable, variant-friendly counts.
--
-- Owner-approved 2026-08-08. Four facts this phase stores:
--   • assignee_staff_id — the PERSON RESPONSIBLE for the count, picked at
--     creation (required by the route for new takes; nullable so historical
--     rows stay valid). Posting is gated to the assignee or a holder of the
--     new scm.stock_take.supervise permission (services/permissions.ts).
--   • blind — per-take blind-count flag. While the take is OPEN, a caller
--     without the supervise permission receives system_qty / variance as NULL
--     (stripped server-side in routes/stock-takes.ts, not hidden client-side).
--   • counted_by / counted_at on each LINE — WHO entered the counted qty and
--     WHEN. Stamped by PATCH /:id/lines from the caller's REAL scm.staff uuid
--     (mig 0066 bridge via resolveCallerStaffId), never the pinned system row.
--   • scope_type gains 'NONZERO' — "SKUs with system qty <> 0", shrinking a
--     full-warehouse sheet to the buckets that actually hold stock.
--
-- No seed rows: the supervise permission is a code-defined flat key (Owner +
-- IT Admin pass via "*"; other positions are granted via Team > Positions).
--
-- Houzs conventions: search_path pinned exactly as 0084/0267 do AND every ref
-- schema-qualified (an unqualified name binding to public.* is the 0267
-- deploy-blocker class); no inner BEGIN/COMMIT (pg-migrate owns the txn);
-- additive + idempotent — safe to apply before the code deploys (old code
-- ignores the new columns; existing rows behave exactly as before).
SET search_path TO scm, public;

ALTER TABLE scm.stock_takes ADD COLUMN IF NOT EXISTS assignee_staff_id uuid REFERENCES scm.staff(id) ON DELETE SET NULL;
ALTER TABLE scm.stock_takes ADD COLUMN IF NOT EXISTS blind boolean NOT NULL DEFAULT false;
ALTER TABLE scm.stock_take_lines ADD COLUMN IF NOT EXISTS counted_by uuid REFERENCES scm.staff(id) ON DELETE SET NULL;
ALTER TABLE scm.stock_take_lines ADD COLUMN IF NOT EXISTS counted_at timestamptz;
ALTER TABLE scm.stock_takes DROP CONSTRAINT IF EXISTS stock_takes_scope_type_chk;
ALTER TABLE scm.stock_takes ADD CONSTRAINT stock_takes_scope_type_chk CHECK (scope_type IN ('ALL','CATEGORY','CODE_PREFIX','NONZERO'));
