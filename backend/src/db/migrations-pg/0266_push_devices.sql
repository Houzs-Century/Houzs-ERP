-- 0266_push_devices.sql — iOS push: device token registry.
--
-- ⚠️ RE-CHECK NUMBER AT MERGE. 0266 was the next free number when this file was
-- written. Re-list the tree at merge and renumber to highest-on-main + 1 if it
-- was taken in the meantime (duplicate numbers wedge pg-migrate; gaps are fine).
--
-- WHAT THIS ADDS. public.push_devices — one row per (user, device token) the
-- native iOS app registers after the user grants notification permission. The
-- daily fleet-reminder push job (services/pushFleetReminders.ts) reads it; the
-- APNs feedback loop disables rows whose token Apple reports dead (410 /
-- BadDeviceToken) rather than deleting them, so a device that comes back after
-- an OS restore re-activates by re-registering the same token.
--
-- WHY public, NOT scm: the owner is a public.users row (serial int), same side
-- as sessions/notifications. Fleet is only the FIRST producer; the registry is
-- app-wide.
--
-- last_reminder_sent_on: idempotency stamp for the daily job. The 30-min cron
-- slot fires twice inside the send hour — the date stamp is what makes the
-- second pass a no-op. Per-DEVICE, so a token registered at noon still gets its
-- first push the next morning rather than mid-day.
--
-- HOUSE STYLE. Additive, idempotent (IF NOT EXISTS). Text timestamps matching
-- public-schema tables (app reads ISO strings). pg-migrate runs the file in one
-- transaction.

CREATE TABLE IF NOT EXISTS public.push_devices (
  id                    SERIAL PRIMARY KEY,
  user_id               INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  platform              TEXT NOT NULL DEFAULT 'ios' CHECK (platform IN ('ios')),
  -- APNs device token, hex. Unique across users: a phone that changes hands
  -- re-registers under the new signer and the row must follow the device.
  token                 TEXT NOT NULL UNIQUE,
  created_at            TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  last_seen_at          TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  -- Set when APNs says the token is dead; cleared by a successful re-register.
  disabled_at           TEXT,
  last_error            TEXT,
  last_reminder_sent_on TEXT
);

CREATE INDEX IF NOT EXISTS idx_push_devices_user ON public.push_devices (user_id);
