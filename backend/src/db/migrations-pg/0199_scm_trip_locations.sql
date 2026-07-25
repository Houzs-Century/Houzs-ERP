-- 0199_scm_trip_locations.sql — LIVE GPS ping log for TMS Phase 4.
--
-- RE-CHECK NUMBER AT MERGE. This was the next free number above the highest on
-- main at branch time (0198). Parallel PRs may claim it first; re-list
-- backend/src/db/migrations-pg/ at MERGE time and renumber if 0199 is taken.
-- pg-migrate tracks by FULL FILENAME, so a DUPLICATE number is what breaks the
-- deploy — a gap is safe.
--
-- WHY. Phase 4 is live driver tracking with NO websockets (polling is this
-- repo's realtime mechanism). The driver keeps the delivery page open on their
-- phone; the browser Geolocation API reports coordinates every ~20-30s; this
-- table is where each report lands. The dispatcher's Trips / Delivery-Planning
-- map then POLLS the latest row per driver to move the marker. It is an
-- APPEND-ONLY ping log — one row per report, never updated — so the trail can be
-- replayed and a stale marker is just an old row, never a lie.
--
-- CAPTURE ONLY DURING AN ACTIVE TRIP (privacy). A ping is accepted only for a
-- trip in an IN_PROGRESS state and only from the driver's own trip; the frontend
-- stops watching when the trip completes or the page is backgrounded. There is
-- no background / persistent tracking. The FK is ON DELETE CASCADE so deleting a
-- trip takes its whole location trail with it.
--
-- MULTI-COMPANY. Company-scoped exactly like the rest of scm (company_id NOT
-- NULL REFERENCES public.companies): a ping belongs to its trip's company. TMS
-- is a cross-company VIEW, but a stored row still carries its own company so the
-- allowed-company scope can filter the board-level read.
--
-- recorded_at vs received_at. recorded_at is the DEVICE clock (when the phone's
-- GPS fixed the position); received_at is the SERVER clock (when the ping
-- landed). "Last seen" staleness on the dispatcher map is measured from
-- received_at — a phone with a wrong clock cannot make a stale marker look
-- fresh, and clock skew between devices does not reorder the trail.
--
-- HOUSE STYLE. Additive, idempotent (IF NOT EXISTS), schema-qualified, no
-- runtime self-apply. pg-migrate runs the whole file in one transaction.

SET search_path = scm, public;

CREATE TABLE IF NOT EXISTS scm.trip_locations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    BIGINT NOT NULL REFERENCES public.companies(id),
  trip_id       UUID NOT NULL REFERENCES scm.trips(id) ON DELETE CASCADE,
  -- The fleet driver this ping is attributed to (the trip's driver_id snapshot).
  -- Nullable: a trip can be crewed by a helper phone, or the driver row may be
  -- unset — the ping is still a valid position for the trip.
  driver_id     UUID NULL REFERENCES scm.drivers(id) ON DELETE SET NULL,
  -- The public.users id of whoever's phone posted it (audit — WHICH person's
  -- device). BIGINT to match public.users.id; no FK across schemas by design
  -- (the scm tables reference public only for companies).
  user_id       BIGINT NULL,
  lat           DOUBLE PRECISION NOT NULL,
  lng           DOUBLE PRECISION NOT NULL,
  -- Geolocation accuracy in metres (position.coords.accuracy). Nullable — some
  -- devices omit it; a low-confidence fix can then be dimmed on the map.
  accuracy_m    DOUBLE PRECISION NULL,
  -- Device clock: when the GPS fixed this position.
  recorded_at   TIMESTAMPTZ NOT NULL,
  -- Server clock: when the ping was accepted. "Last seen" is measured from here.
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The dispatcher read is "latest ping for this trip" — a reverse scan on
-- (trip_id, recorded_at DESC) answers it with a single index seek, and the same
-- index serves the trail replay (all pings of a trip, newest first).
CREATE INDEX IF NOT EXISTS idx_trip_locations_trip_recorded
  ON scm.trip_locations (trip_id, recorded_at DESC);

-- The board-level read is "latest ping across every active trip", filtered to
-- the caller's allowed companies — company_id leads that scan.
CREATE INDEX IF NOT EXISTS idx_trip_locations_company_recorded
  ON scm.trip_locations (company_id, recorded_at DESC);
