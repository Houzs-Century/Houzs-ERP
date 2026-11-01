-- The office Last Mile board shows each lorry run's PLANNED departure time beside
-- its actual (clock-in) departure, and flags a run that left more than 15 min
-- late (owner 2026-11-01, Last Mile redesign phase 2). The trip's ACTUAL
-- departure already lives on clock_in_at (mig 0053); there was no planned-time
-- column. Additive, nullable TIMESTAMPTZ, written by PATCH /trips/:id (the crew
-- modal's "Planned departure" field); null until a dispatcher sets it, which the
-- card renders as "actual only".
-- REVERSAL: ALTER TABLE scm.trips DROP COLUMN IF EXISTS planned_depart_at;
ALTER TABLE scm.trips ADD COLUMN IF NOT EXISTS planned_depart_at timestamptz;
