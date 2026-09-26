-- 20260926T2100_scm_delivery_planning_row_marks.sql
--
-- Manual colour marks on Delivery Planning board rows (owner 2026-09-26: 色板标记).
--
-- A dispatcher paints a row a colour to group / flag it by eye; the mark is
-- SHARED — everyone looking at the board sees it — so it cannot live in a
-- browser. One row per board row, keyed by the board's own row id
-- (`so:<doc_no>` / `assr:<id>` / `dp:<id>` / `project:<id>` — `rowIdOf`), which is
-- already globally unique across the two companies (doc numbers do not collide),
-- so the mark needs no company column of its own.
--
--   row_key    the board row id it paints.
--   colour     one of the fixed palette tokens (red / amber / green / blue /
--              grey) — the token, not a hex, so the frontend owns the exact tint
--              and it can be restyled without a migration. The route rejects any
--              token outside the palette, so an unknown value can never be stored.
--   marked_by  who last painted it (audit only; a mark carries no permission).
--
-- Cosmetic: a mark grants nothing and gates nothing. Clearing a mark deletes the
-- row rather than storing a "none", so an unmarked board writes nothing.
--
-- REVERSAL: DROP TABLE IF EXISTS scm.delivery_planning_row_marks;

CREATE TABLE IF NOT EXISTS scm.delivery_planning_row_marks (
  row_key    text        PRIMARY KEY,
  colour     text        NOT NULL,
  marked_by  uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE scm.delivery_planning_row_marks IS
  'Manual colour tags on Delivery Planning board rows, keyed by rowIdOf (so:/assr:/dp:/project:). Cosmetic and shared across all viewers; the route restricts colour to a fixed palette.';

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Read and written by the Worker through PostgREST as the service role, like the
-- rest of the scm board config.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON scm.delivery_planning_row_marks TO service_role;
  END IF;
END
$grant$;

-- Let PostgREST see the new table without a manual reload.
NOTIFY pgrst, 'reload schema';
