-- 0137_trip_stops_dp_no.sql — give EVERY scheduled job a DP number, not just the
-- manually-created ones.
--
-- THE GAP THIS CLOSES. The owner's numbering rule (2026-07-18, "DP 应该根据年月日、
-- 罗里编号以及张单" → DP-260718-WPX01) was implemented only on the manual path:
-- `mintDpNo` had exactly ONE caller, dp-orders.ts's schedule handler. The normal
-- paths — a delivery or service scheduled from the board, which is the MAJORITY of
-- jobs — reach `scheduleOntoTrip` in delivery-planning.ts, write a `trip_stops` row,
-- and never get a number at all. So the numbering scheme covered the minority of
-- jobs while appearing to cover all of them.
--
-- WHY THE NUMBER LIVES HERE, not on a mirrored dp_orders row. The thing being
-- numbered is "this job, on this lorry, on this day" — and that IS a trip_stop, in
-- every path. Creating a shadow dp_orders row for each scheduled SO would have
-- double-counted it on the board (the board UNIONs SO + ASSR + DP sources, so the
-- SO would appear twice), and would have duplicated the customer/address data that
-- already lives on the SO. One stop, one number.
--
-- dp_orders.dp_no is KEPT and unchanged: a DP order can be scheduled header-only
-- (a date + lorry, no trip yet), which mints a number with no stop to hang it on.
-- When it does get a stop, the stop carries the SAME number — mirror, not a second
-- identity. The minter therefore reads BOTH tables (lib/dp-no-mint.ts) so the two
-- paths cannot hand out the same number.
--
-- UNIQUENESS uses COALESCE(company_id) because company_id is nullable here (the
-- dp-orders insert writes `activeCompanyId(c) ?? null`). A plain UNIQUE (company_id,
-- dp_no) would treat every NULL company as distinct and silently permit duplicates
-- in exactly the rows least likely to be noticed. Two companies may legitimately run
-- the same plate letters on the same day, so the company stays in the key.
--
-- HOUSE STYLE (0128/0129/0134): additive, IF NOT EXISTS, plain statements, no
-- runtime self-apply, SET search_path.

SET search_path = public, scm;

ALTER TABLE scm.trip_stops
  ADD COLUMN IF NOT EXISTS dp_no text;

-- Partial: only NUMBERED stops participate. Stops predating this migration keep
-- dp_no NULL and are ignored by the constraint (and by the minter's max+1 scan),
-- so this is safe to apply to a populated table and needs no backfill.
CREATE UNIQUE INDEX IF NOT EXISTS uq_trip_stops_dp_no
  ON scm.trip_stops (COALESCE(company_id::text, ''), dp_no)
  WHERE dp_no IS NOT NULL;

-- The minter scans one day's numbers by prefix (LIKE 'DP-260718-%'); without this
-- it is a seq scan of every stop ever made, on the hot scheduling path.
CREATE INDEX IF NOT EXISTS idx_trip_stops_dp_no_prefix
  ON scm.trip_stops (dp_no text_pattern_ops)
  WHERE dp_no IS NOT NULL;
