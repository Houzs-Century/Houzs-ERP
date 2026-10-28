-- 080_assr_lead_time_schedule_history.sql
--
-- Lead Time Portal additions:
--   1. Scheduled activations queue — admin defers a profile swap
--      to a future date+time (e.g. "swap to Peak next Monday
--      00:00 MYT for Hari Raya rush"). A cron worker picks pending
--      rows whose scheduled_for is past and applies them.
--   2. Activation history — one row per ACTUAL activation event
--      (manual or scheduled-fired), so audit can see "Profile X
--      went live at Y, switched from Z, by user U".
--
-- Mig 075's amendment log (assr_lead_time_amendments) is untouched —
-- it captures per-target stage-day changes, which is a separate axis
-- from "which profile is active".

CREATE TABLE assr_lead_time_scheduled_activations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id      INTEGER NOT NULL REFERENCES assr_lead_time_profiles(id) ON DELETE CASCADE,
  scheduled_for   TEXT NOT NULL,
  scheduled_by    INTEGER REFERENCES users(id),
  reason          TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','fired','cancelled')),
  fired_at        TEXT,
  cancelled_at    TEXT,
  cancelled_by    INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_assr_lt_sched_pending
  ON assr_lead_time_scheduled_activations(status, scheduled_for);

CREATE TABLE assr_lead_time_activations (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id             INTEGER NOT NULL REFERENCES assr_lead_time_profiles(id),
  source                 TEXT NOT NULL
                            CHECK (source IN ('manual','scheduled')),
  scheduled_id           INTEGER REFERENCES assr_lead_time_scheduled_activations(id),
  user_id                INTEGER REFERENCES users(id),
  previous_profile_id    INTEGER,
  activated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_assr_lt_acts_at      ON assr_lead_time_activations(activated_at);
CREATE INDEX idx_assr_lt_acts_profile ON assr_lead_time_activations(profile_id, activated_at);
