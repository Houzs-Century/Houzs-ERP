-- 0250 — flag a position that came from a mock-location app.
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
-- MERGE — 0250 was next free above 0249.

SET search_path = scm, public;

ALTER TABLE scm.trip_locations
  ADD COLUMN IF NOT EXISTS simulated BOOLEAN NOT NULL DEFAULT false;

-- The read that matters is "did this trip have any faked position", which is a
-- rare scan over a large table. Partial index: only the flagged rows are worth
-- indexing, and there should be none.
CREATE INDEX IF NOT EXISTS idx_trip_locations_simulated
  ON scm.trip_locations (trip_id, recorded_at DESC)
  WHERE simulated;
