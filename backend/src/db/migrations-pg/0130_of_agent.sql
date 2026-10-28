-- 0130_of_agent.sql — Order Fulfilment Agent (HZS-OF-001) engine tables.
--
-- The readiness CORE (services/agents/order-fulfilment.ts, PR #729) computes a
-- per-SO readiness score + blocker list. This makes it a running agent: a daily
-- patrol over open Sales Orders that writes one OPEN finding per blocked order,
-- with the precise blocker, its owner and the next action (spec §3.7).
--
-- FINDINGS shape (mirrors the Document agent, 0093): one OPEN row per (SO), auto-
-- resolved when the order becomes ready or leaves the pipeline. READ-ONLY over
-- business documents — these two public-schema tables are the ONLY thing the
-- engine writes.
--
-- HOUSE STYLE (0091/0093/0096): no runtime self-apply, IF NOT EXISTS, plain
-- statements, public schema, text ids + ISO-string timestamps.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS of_agent_findings (
  id           text PRIMARY KEY,
  kind         text NOT NULL,                         -- NOT_READY (the blocked-order finding)
  severity     text NOT NULL DEFAULT 'WARN',          -- INFO | WARN | CRIT
  so_doc_no    text NOT NULL,                          -- the order
  readiness    integer NOT NULL DEFAULT 0,             -- 0..100 score at last patrol
  top_blocker  text,                                   -- the leading blocker code
  owner        text,                                   -- SALES | FINANCE | PROCUREMENT | WAREHOUSE | OFFICE
  summary      text NOT NULL,                          -- one plain-English sentence
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,     -- full blocker list + score
  status       text NOT NULL DEFAULT 'OPEN',           -- OPEN | RESOLVED
  created_at   text NOT NULL,
  last_seen_at text NOT NULL,
  resolved_at  text
);

-- At most one OPEN finding per order (the patrol refreshes it in place).
CREATE UNIQUE INDEX IF NOT EXISTS uq_of_agent_findings_open
  ON of_agent_findings (so_doc_no) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS idx_of_agent_findings_status
  ON of_agent_findings (status, severity, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS of_agent_briefs (
  id           text PRIMARY KEY,
  generated_at text NOT NULL,
  brief        jsonb NOT NULL,
  ai_focus     text
);

CREATE INDEX IF NOT EXISTS idx_of_agent_briefs_generated
  ON of_agent_briefs (generated_at DESC);
