-- 0148_venue_binding.sql (Postgres)
-- VENUE BINDING (owner 2026-07-19) — a salesperson gets bound to a venue by TWO
-- coexisting mechanisms, and an SO's venue resolves from them in a fixed order:
--
--   1. PMS / exhibition — the rep is the PIC or a Sales Attending rep on a
--      project whose PERIOD CONTAINS the order date -> that project's venue.
--      (Already exists: public.projects + public.project_sales_attendees.)
--   2. Showroom — the rep is "parked under" a Showroom -> that showroom's venue.
--      (NEW. A Showroom is a scm.warehouses row FLAGGED as one.)
--   3. Nothing. Empty is the honest answer; there is no company default.
--
-- The owner explicitly REJECTED making the two mutually exclusive: a showroom
-- salesperson sent to an exhibition is normal and frequent, and exclusion would
-- make the venue wrong precisely during the exhibition — which is exactly when
-- venue accuracy matters, because venue feeds exhibition P&L and commission.
-- So PMS is a higher-priority DEFAULT, not a lock.
--
-- THREE COLUMNS, all additive / nullable / no backfill. Each is a no-op on
-- existing rows, so this file cannot fail on prod data (it auto-applies on every
-- deploy, and a failed file blocks EVERY deploy).

-- ── 1. Showroom flag on the warehouse master ────────────────────────────────
-- Owner: "the Venue list should be fed from project venues AND from warehouses
-- flagged as Showroom". So Showroom is a FLAG on scm.warehouses, not a new
-- entity — the physical showroom already exists there as a stock location, and
-- a second table would immediately drift from it.
--
-- venue_name is SEPARATE from warehouses.name and deliberately NOT defaulted to
-- it. A warehouse is named for stock ("KL-SHOWROOM"); a venue is named for the
-- report ("Kuala Lumpur Showroom"). Auto-deriving one from the other would put a
-- stock code into exhibition P&L. NULL venue_name on a flagged showroom resolves
-- to NOTHING, which is the honest answer — see the resolver's rule 3.
ALTER TABLE scm.warehouses
  ADD COLUMN IF NOT EXISTS is_showroom boolean NOT NULL DEFAULT false;

ALTER TABLE scm.warehouses
  ADD COLUMN IF NOT EXISTS venue_name text;

-- The Sales Maintenance venue list and the resolver both filter on the flag.
CREATE INDEX IF NOT EXISTS idx_warehouses_is_showroom
  ON scm.warehouses (is_showroom) WHERE is_showroom;

-- ── 2. "Parked under a Showroom" — the Members-page binding ─────────────────
-- scm.staff already carries `showroom_id uuid` FK -> scm.showrooms, vendored
-- from the 2990 POS. That is NOT reused here: scm.showrooms is a separate,
-- EMPTY, POS-specific table, and the owner's showroom is a flagged WAREHOUSE.
-- Pointing this at scm.warehouses keeps ONE showroom vocabulary.
--
-- ON DELETE SET NULL is correct HERE (unlike the scm.staff FK trap where a
-- master delete silently nulls a salesperson on live documents): deleting a
-- warehouse must not delete the person, and an unparked rep simply resolves to
-- nothing. It does mean a warehouse delete silently unparks everyone under it —
-- which is visible on the Members page, and is the intended read.
ALTER TABLE scm.staff
  ADD COLUMN IF NOT EXISTS showroom_warehouse_id uuid
    REFERENCES scm.warehouses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_staff_showroom_warehouse_id
  ON scm.staff (showroom_warehouse_id);

-- ── 3. How the venue on an SO got there ─────────────────────────────────────
-- 'PMS' | 'SHOWROOM' | 'MANUAL' | NULL(unknown/legacy).
--
-- THIS COLUMN IS WHAT PROTECTS A HUMAN'S CHOICE. The binding is a DEFAULT, not
-- a lock: whatever resolves stays editable, and once a person edits the venue
-- the row is marked MANUAL and NO automatic re-resolve may ever overwrite it.
-- Without this marker a re-resolve cannot tell "the resolver put this here" from
-- "a human deliberately corrected this", and would silently undo the correction.
--
-- NULL on every existing row is deliberate and is NOT read as MANUAL: legacy
-- rows are simply of unknown provenance. Nothing re-resolves an existing SO
-- today, so the distinction only starts mattering the moment something does.
ALTER TABLE scm.mfg_sales_orders
  ADD COLUMN IF NOT EXISTS venue_source text;
