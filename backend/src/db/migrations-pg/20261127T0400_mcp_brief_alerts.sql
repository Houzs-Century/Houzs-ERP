-- 20261127T0400_mcp_brief_alerts.sql
--
-- WHY. Owner 2026-11-26 (AI Connector round 4d): a person who may use the AI
-- Connector can opt in to a morning brief email (their time, weekdays or every
-- day) and to urgent alerts (newly overdue SO / PO above a value, service cases
-- newly past SLA, stock below zero). The cron builds both AS THAT PERSON through
-- the connector's own in-process reads (services/mcp-proactive-run.ts), so their
-- permissions and money strip apply exactly.
--
--   mcp_brief_subscriptions  one row per person: the two switches, time (HH:MM,
--                            MYT, quarter hour), days ('weekdays' | 'daily'),
--                            the one-click unsubscribe token, the MYT day the
--                            brief was last claimed (the per-day idempotency
--                            claim) and when alerts were last checked (fair
--                            batching: oldest first).
--   mcp_alert_sent           debounce: one row per person + alert key + MYT day
--                            the alert was emailed. A key is not emailed again
--                            within the repeat window (services/mcp-proactive.ts
--                            ALERT_THRESHOLDS.repeatAfterDays), never twice a day.
--
-- No email body is stored here. Sends are logged in mcp_calls (kind + counts)
-- and email_log (subject, status) by the existing sender.
--
-- Additive, idempotent, no data. RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   DROP TABLE IF EXISTS public.mcp_alert_sent;
--   DROP TABLE IF EXISTS public.mcp_brief_subscriptions;
--   Revert the code first (the cron and routes/mcpAdmin.ts read both tables). GRANTS: none to re-apply.

CREATE TABLE IF NOT EXISTS public.mcp_brief_subscriptions (
  user_id             bigint      PRIMARY KEY,
  brief_enabled       boolean     NOT NULL DEFAULT false,
  brief_time          text        NOT NULL DEFAULT '08:00',
  brief_days          text        NOT NULL DEFAULT 'weekdays',
  alerts_enabled      boolean     NOT NULL DEFAULT false,
  unsubscribe_token   text        NOT NULL UNIQUE,
  last_brief_day      text,
  last_alert_check_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcp_brief_subscriptions_days_chk CHECK (brief_days IN ('weekdays', 'daily')),
  CONSTRAINT mcp_brief_subscriptions_time_chk CHECK (brief_time ~ '^([01][0-9]|2[0-3]):(00|15|30|45)$')
);
CREATE INDEX IF NOT EXISTS mcp_brief_subscriptions_brief_idx ON public.mcp_brief_subscriptions (brief_enabled, last_brief_day);
CREATE INDEX IF NOT EXISTS mcp_brief_subscriptions_alerts_idx ON public.mcp_brief_subscriptions (alerts_enabled, last_alert_check_at);

CREATE TABLE IF NOT EXISTS public.mcp_alert_sent (
  user_id    bigint      NOT NULL,
  alert_key  text        NOT NULL,
  sent_day   text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, alert_key, sent_day)
);
CREATE INDEX IF NOT EXISTS mcp_alert_sent_user_day_idx ON public.mcp_alert_sent (user_id, sent_day);
