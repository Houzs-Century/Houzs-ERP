-- 20260927T0900_scm_delivery_planning_row_order.sql
--
-- Manual row order for the Delivery Planning board (owner 2026-09-26: 拖动行手动排).
--
-- A dispatcher drags rows into the order they want to work them; that order is
-- SHARED (everyone sees it) and only decides the board's DEFAULT sort — the
-- moment someone clicks a column header the manual order stands aside, and
-- clearing the column sort brings it back (that is the board's existing
-- defaultSort slot, so nothing new fights the column sorts).
--
-- ONE row holds the whole order as a jsonb ARRAY of board row ids (`rowIdOf`:
-- so:<doc_no> / assr:<id> / dp:<id> / project:<id>), in the order to show them.
-- A single array, not a per-row index, so a drag is one replace, not a
-- renumber; rows absent from the array (new orders, or ones never dragged) fall
-- after the listed ones in the board's natural server order, and a stale id the
-- array still lists is simply skipped. The board is one cross-company queue, so
-- there is one order for both companies (`scope = 'board'`).
--
-- REVERSAL: DROP TABLE IF EXISTS scm.delivery_planning_row_order;

CREATE TABLE IF NOT EXISTS scm.delivery_planning_row_order (
  scope        text        PRIMARY KEY DEFAULT 'board',
  ordered_keys jsonb       NOT NULL DEFAULT '[]'::jsonb,
  updated_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE scm.delivery_planning_row_order IS
  'Manual drag order for the Delivery Planning board: one row (scope=board) whose ordered_keys jsonb array lists rowIdOf ids in display order. Shared; only drives the board default sort (a column sort overrides it).';

-- ── Grants ──────────────────────────────────────────────────────────────────
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON scm.delivery_planning_row_order TO service_role;
  END IF;
END
$grant$;

-- Let PostgREST see the new table without a manual reload.
NOTIFY pgrst, 'reload schema';
