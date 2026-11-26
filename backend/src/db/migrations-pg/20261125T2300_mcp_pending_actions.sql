-- 20261125T2300_mcp_pending_actions.sql
--
-- WHY. Owner 2026-11-26: the AI Connector may now do two ordinary things for the
-- signed-in person — book a meeting and send an email — but only "confirm first,
-- then do". The AI's propose_meeting / propose_email store the checked request
-- here and show the person a summary; confirm_action claims the row ONCE (UPDATE
-- ... WHERE used_at IS NULL AND expires_at > now RETURNING) and only then calls
-- the ERP's own create-meeting / Mail Center send route as that person
-- (routes/mcp.ts, services/mcp-actions.ts, middleware/auth.ts ACTION_ALLOWLIST).
--
--   mcp_pending_actions  one proposed action: whose token, what kind, the
--                        checked payload, a plain summary, 10-minute expiry,
--                        when it was used and how it ended.
--
-- The on/off switch ("Allow AI actions", default OFF) lives in app_settings under
-- key 'mcp_actions_enabled'; an absent row means OFF, so nothing is seeded here.
--
-- Additive, idempotent, no data. RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   DROP TABLE IF EXISTS public.mcp_pending_actions;
--   DELETE FROM public.app_settings WHERE key = 'mcp_actions_enabled';
--   Revert the code first (routes/mcp.ts reads the table). GRANTS: none to re-apply.

CREATE TABLE IF NOT EXISTS public.mcp_pending_actions (
  id           text        PRIMARY KEY,
  token_id     text        NOT NULL,
  user_id      bigint      NOT NULL,
  kind         text        NOT NULL,
  payload_json text        NOT NULL,
  summary      text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  outcome      text,
  outcome_note text
);
CREATE INDEX IF NOT EXISTS mcp_pending_actions_user_used_idx ON public.mcp_pending_actions (user_id, used_at);
