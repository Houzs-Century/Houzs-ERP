-- 20261016T0920_ai_usage_events.sql
-- REVERSAL: DROP TABLE IF EXISTS public.ai_usage_events;
--   Additive log table; nothing reads it except the IT "AI Usage" page
--   (routes/aiUsage.ts). The recorder (services/aiUsage.ts) swallows a failed
--   insert, so the old Worker and the new Worker both keep running with the table
--   gone; the page then shows only the agent_runs back-fill. GRANTS: the ones
--   below go with the table.
--
-- WHY (DEV-35 IT pages): the Anthropic bill had no breakdown. Only the agents
-- logged tokens (agent_runs); every OCR scan, translation, distill and cache warm
-- was invisible. One row per Anthropic call, written right after the fetch.
--
--   feature      stable call-site name: scan_so, scan_payment, bill_extract,
--                agent:delivery ... (docs/modules/ai-usage.md lists them)
--   company_id   the caller's active company when the call site knows it, else NULL
--   user_id      the Houzs user behind the call when known (crons, agents: NULL)
--   *_tokens     straight from the Anthropic response `usage` block
--   ok           false on an HTTP error, an `error` body or a network failure
--   error        trimmed error text when ok is false
--   http_status  NULL when the request never got a response
SET search_path = public;

CREATE TABLE IF NOT EXISTS public.ai_usage_events (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at         timestamptz NOT NULL DEFAULT now(),
  feature            text        NOT NULL,
  company_id         integer     NULL,
  user_id            integer     NULL,
  model              text        NOT NULL,
  input_tokens       integer     NOT NULL DEFAULT 0,
  output_tokens      integer     NOT NULL DEFAULT 0,
  cache_read_tokens  integer     NOT NULL DEFAULT 0,
  cache_write_tokens integer     NOT NULL DEFAULT 0,
  ok                 boolean     NOT NULL,
  error              text        NULL,
  http_status        integer     NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_events_created_at ON public.ai_usage_events (created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_feature_created_at ON public.ai_usage_events (feature, created_at);

COMMENT ON TABLE public.ai_usage_events IS
  'One row per Anthropic API call (tokens, ok/error). Written by services/aiUsage.ts, read by the IT AI Usage page.';

-- The Worker writes and reads this over Hyperdrive as the owner role (same as
-- scm.sheet_sync_usage). RLS is deliberately NOT enabled: the prod Hyperdrive
-- role's name is not in this repo (see 0191), and an RLS table with no policy
-- would silently refuse it if it is not the owner. Instead the browser-facing
-- PostgREST roles get nothing, which is what keeps the log off the public API.
REVOKE ALL ON public.ai_usage_events FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.ai_usage_events FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.ai_usage_events FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT ON public.ai_usage_events TO service_role;
  END IF;
END
$grant$;
