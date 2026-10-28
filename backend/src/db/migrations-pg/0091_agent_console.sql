-- 0091_agent_console.sql — Agent Console runtime tables (port of the HOOKKA
-- agent fleet skeleton; owner OK 2026-07-13 "照搬 verbatim").
--
--   agent_runs        one row per agent execution, with status, summary,
--                     token usage and error (recordAgentRun writes these).
--   agent_controls    one row per agent FAMILY (DELIVERY / DOCUMENT / CS)
--                     plus the special agent='ALL' global kill-switch row.
--                     paused stops automatic runs; auto_approve is the
--                     autonomy gate.
--   config_proposals  learner-emitted parameter change proposals the owner
--                     approves/rejects on the console; approval writes the
--                     value through the whitelist in services/agent-console.ts.
--   agent_feedback    the agents' notebook of standing owner instructions;
--                     ACTIVE rows are injected into LLM brain calls.
--
-- HOUZS ADAPTATIONS vs HOOKKA:
--   * No runtime self-apply (HOOKKA's ensure* CREATE-IF-NOT-EXISTS pattern):
--     Houzs migrates-before-deploy — the lib code assumes these tables exist.
--   * All timestamps TEXT (ISO strings) to match the public schema house
--     style (mig 0008 forced TEXT; 0058 announcements precedent).
--   * Boolean flags integer 0/1 (matches rest of public schema).
--   * Tables live in PUBLIC (org-wide, not SCM).
--
-- Plain statements only (pg-migrate splits on ';\n' — no PL/pgSQL bodies).
-- Idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING) so the CI auto-apply
-- re-run is a no-op.

SET search_path = public, scm;

-- One row per agent execution (heartbeat, cron or Run-now).
CREATE TABLE IF NOT EXISTS agent_runs (
  id          text PRIMARY KEY,                        -- crypto.randomUUID()
  agent       text NOT NULL,                           -- task id, e.g. 'delivery-run'
  started_at  text NOT NULL,                           -- ISO string
  finished_at text,
  status      text NOT NULL DEFAULT 'running',         -- running | ok | error
  summary     text,                                    -- human one-liner for the console
  tokens_in   integer NOT NULL DEFAULT 0,
  tokens_out  integer NOT NULL DEFAULT 0,
  error       text
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_agent
  ON agent_runs (agent, started_at DESC);

-- One row per agent family + the 'ALL' kill-switch row.
CREATE TABLE IF NOT EXISTS agent_controls (
  agent        text PRIMARY KEY,                       -- DELIVERY | DOCUMENT | CS | ALL
  paused       integer NOT NULL DEFAULT 0,             -- 0/1
  auto_approve integer NOT NULL DEFAULT 0,             -- 0/1 (autonomy gate)
  updated_at   text
);

-- Seed the global kill-switch row so the console always has it to toggle.
INSERT INTO agent_controls (agent, paused, auto_approve, updated_at)
VALUES ('ALL', 0, 0, now()::text)
ON CONFLICT (agent) DO NOTHING;

-- Learner-emitted parameter proposals (PENDING until the owner decides, or
-- the family's auto-approve gate applies them as decided_by='AGENT_AUTO').
CREATE TABLE IF NOT EXISTS config_proposals (
  id             text PRIMARY KEY,
  generated_at   text NOT NULL,
  param_key      text NOT NULL,                        -- whitelisted, e.g. 'delivery.transitDays.JHR'
  current_value  text,
  proposed_value text NOT NULL,
  reason         text,
  status         text NOT NULL DEFAULT 'PENDING',      -- PENDING | APPROVED | REJECTED
  decided_at     text,
  decided_by     text                                  -- users.id as text, or 'AGENT_AUTO'
);

CREATE INDEX IF NOT EXISTS idx_config_proposals_status
  ON config_proposals (status, generated_at DESC);

-- Standing owner instructions per agent (never hard-deleted — RETIRED).
CREATE TABLE IF NOT EXISTS agent_feedback (
  id          text PRIMARY KEY,
  created_at  text NOT NULL,
  agent       text NOT NULL,                           -- family id
  instruction text NOT NULL,
  created_by  text,                                    -- users.id as text
  status      text NOT NULL DEFAULT 'ACTIVE',          -- ACTIVE | RETIRED
  retired_at  text
);

CREATE INDEX IF NOT EXISTS idx_agent_feedback_agent
  ON agent_feedback (agent, status);
