-- 076_assr_alerts.sql
--
-- ASSR/QMS v3.1 — Phase C: Alert + reminder engine state.
--
-- The legacy SLA escalation (mig 012 + assrEscalation.ts) only fires
-- once when a case crosses 24h past its deadline. v3.1 expands this
-- to a per-stage 5-event engine (proposal §9):
--
--   stage_entered      — owner notified on entry
--   half_time          — 50% of stage target elapsed
--   approaching_breach — 80% of stage target elapsed (manager loop-in)
--   breach             — >=100% (email + optional WhatsApp/Telegram)
--   daily_digest       — manager digest at 08:00 MYT
--
-- The `alerts_fired` counter on `assr_stage_history` (mig 074) is the
-- idempotency key: every fired event flips the next bit in the mask
-- (1=entered, 2=half, 4=approaching, 8=breach), so re-running the
-- scanner only fires unsent events.
--
-- This migration adds the ack/snooze ledger.

CREATE TABLE assr_alert_acks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assr_id INTEGER NOT NULL REFERENCES assr_cases(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  event TEXT NOT NULL,          -- 'stage_entered' | 'half_time' | 'approaching_breach' | 'breach' | 'manager_override'
  user_id INTEGER NOT NULL REFERENCES users(id),
  note TEXT,                    -- optional, <= 200 chars enforced at route layer
  snoozed_until TEXT,           -- when set, alerts of this stage/event are suppressed until this time
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_assr_alert_acks_case  ON assr_alert_acks(assr_id);
CREATE INDEX idx_assr_alert_acks_active ON assr_alert_acks(assr_id, stage, event, snoozed_until);
