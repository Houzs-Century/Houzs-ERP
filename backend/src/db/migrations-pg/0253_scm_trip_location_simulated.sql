-- 0253 — flag a position that came from a mock-location app.
--
-- WHY. The native background watcher (@capacitor-community/background-geolocation)
-- reports `simulated: true` when a fix was produced by software rather than by
-- the GPS chip. A browser cannot tell the difference; the app can, and dropping
-- that on the floor would repeat the mistake mig 0249 exists to fix — a signal
-- the device already hands us, discarded because there was no column.
--
-- It matters here more than most places. Trip locations are about to answer a
-- CUSTOMER-facing question ("where is my delivery"), and a driver running a
-- mock-location app can put the lorry anywhere. Without this the fake fix is
-- indistinguishable from a real one, forever, in the same table.
--
-- RECORDED, NOT REJECTED. Refusing a simulated ping would leave a gap that looks
-- exactly like lost signal — the most common and most innocent thing in this
-- data. A row that says "this was simulated" is evidence; a missing row is
-- nothing. The decision about what to do with it belongs to whoever reads the
-- trail, not to the write path.
--
-- DEFAULT FALSE, NOT NULL. Every existing row came from the browser watcher,
-- which cannot report simulation — so false is a true statement about them, not
-- a guess. New browser pings keep the default for the same reason.
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified. RE-CHECK THE NUMBER AT
-- MERGE — RENUMBERED FROM 0250 on 2026-08-03: main gained its own 0250, 0251 and
-- 0252 from parallel branches while this one was open, and a duplicate NUMBER is
-- the one thing pg-migrate cannot survive (it tracks by full filename, so gaps
-- and out-of-order merges are fine and collisions are not). Caught by re-listing
-- the tree before merge, which is why that rule exists.
--
-- Safe to rename because it has NOT been applied anywhere: pg-migrate records
-- applied files by filename, so renaming one that has already run would make it
-- a new file and run its SQL a second time.

SET search_path = scm, public;

ALTER TABLE scm.trip_locations
  ADD COLUMN IF NOT EXISTS simulated BOOLEAN NOT NULL DEFAULT false;

-- The read that matters is "did this trip have any faked position", which is a
-- rare scan over a large table. Partial index: only the flagged rows are worth
-- indexing, and there should be none.
CREATE INDEX IF NOT EXISTS idx_trip_locations_simulated
  ON scm.trip_locations (trip_id, recorded_at DESC)
  WHERE simulated;
