-- 0135_agent_kill_scopes_and_decisions.sql — the last two §10 governance pieces.
--
-- 1) KILL SCOPES (§10.6: "Disable Agent, transaction class, tool, company or
--    branch immediately"). agent_controls already carries the GLOBAL switch
--    (agent='ALL') and the per-FAMILY pause — but with two companies on one
--    backend, "stop the agents for 2990 while we sort its data out" had no
--    expression short of stopping them for Houzs too. This table adds the finer
--    scopes without touching the two that work.
--
--    Deliberately a SEPARATE table rather than more columns on agent_controls:
--    that table is keyed by agent, and a company/class kill is not a property of
--    an agent — it is a property of a company or a transaction class, and one
--    kill may cover every family at once.
--
-- 2) DECISION PACKETS (§9.4 / §10.6 "immutable decision and action history").
--    governance.ts has defined the DecisionPacket shape since #725, but nothing
--    stored one: the audit trail was a summary string plus a payload blob, with
--    no options, impact, policy, confidence, reversibility or verification. This
--    is where a decision's REASONING lands, next to what was done.
--
--    Append-only by intent — there is no update path in the code. A decision that
--    turned out wrong is answered with a NEW row, never by editing the old one.
--
-- HOUSE STYLE (0091/0093/0130/0133): no runtime self-apply, IF NOT EXISTS, plain
-- statements, public schema, text ids + ISO-string timestamps.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS agent_kill_scopes (
  id         text PRIMARY KEY,
  scope_type text NOT NULL,          -- COMPANY | CLASS | TOOL
  scope_value text NOT NULL,         -- company id, decision-class key, or tool name
  paused     integer NOT NULL DEFAULT 1,
  reason     text,
  updated_at text NOT NULL,
  updated_by text
);

-- One live row per (type, value): flipping a scope updates, never duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_kill_scopes
  ON agent_kill_scopes (scope_type, scope_value);

CREATE TABLE IF NOT EXISTS agent_decisions (
  id             text PRIMARY KEY,
  agent          text NOT NULL,       -- spec agent id, e.g. HZS-REP-004
  family         text,                -- code family, e.g. PROCUREMENT
  decision_class text NOT NULL,       -- EXTERNAL_PO | CONFIG_TUNING | ...
  statement      text NOT NULL,       -- exactly what was proposed or executed
  reason         text,                -- business reason + trigger
  evidence       jsonb NOT NULL DEFAULT '[]'::jsonb,
  options        jsonb NOT NULL DEFAULT '[]'::jsonb,   -- incl. "do nothing" (§9.4)
  impact         text,
  policy         text,                -- the rule applied
  confidence     numeric(4,3),        -- 0..1
  data_quality   text,                -- GREEN | AMBER | RED at decision time
  reversible     integer NOT NULL DEFAULT 0,
  rollback       text,
  verification   text,
  approver       text,                -- HUMAN user id, or 'AGENT_AUTO'
  approval_required integer NOT NULL DEFAULT 1,
  outcome        text,                -- filled after execution
  created_at     text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_decisions_agent
  ON agent_decisions (agent, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_decisions_class
  ON agent_decisions (decision_class, created_at DESC);
