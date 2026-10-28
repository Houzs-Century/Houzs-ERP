-- 0095_cs_agent.sql — CS Agent engine tables (companion to 0091's agent-console
-- runtime; consumed by services/agents/cs-agent.ts).
--
-- The CS Agent is the customer-service watcher. It runs two deterministic jobs,
-- both PROPOSAL-ONLY: approving a proposal only marks it ready for the office to
-- act on — the engine NEVER edits a sales order or an ASSR case, it writes ONLY
-- cs_agent_proposals + cs_agent_briefs (public schema).
--
--   Job A  PROMISE_DATE — an honest, feasible delivery promise per active SO,
--          computed from live MRP supply (max PO ETA across the SO's lines/sets
--          + the customer state's transit working days). An SO with an uncovered
--          shortage (a line/set short with no PO ETA) CANNOT be promised and is
--          skipped, never given an invented date. A proposal is raised only when
--          the customer currently shows no date, or a date the supply chain
--          cannot hit. `key` = 'PROMISE_DATE:<soDocNo>' so a live SO is never
--          duplicated on the worklist.
--   Job B  ASSR_SLA — OPEN ASSR cases whose deadline_at is already breached or
--          falls inside the warn window. `key` = 'ASSR_SLA:<assrNo>'.
--
--   cs_agent_proposals  PENDING PROMISE_DATE / ASSR_SLA rows; payload carries the
--                       computed basis (stock/po), the feasible date, and the
--                       supply lines that drove it (or the SLA breach detail).
--   cs_agent_briefs     one snapshot per run (deterministic CS picture JSON);
--                       ai_focus is written LATER by the shared agent brain
--                       (nullable — the engine never calls the LLM itself).
--
-- HOUZS HOUSE STYLE (0091 / 0092 / 0094 precedent): no runtime self-apply (Houzs
-- migrates-before-deploy), text ids + text ISO timestamps, PUBLIC schema
-- (org-wide agent runtime, not SCM data), jsonb snapshots. Plain statements only
-- (pg-migrate splits on ';\n'); idempotent so the CI re-run is a no-op.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS cs_agent_proposals (
  id          text PRIMARY KEY,                        -- crypto.randomUUID()
  kind        text NOT NULL,                           -- PROMISE_DATE | ASSR_SLA
  key         text NOT NULL,                           -- dedupe key, e.g. 'PROMISE_DATE:SO-2607-0012'
  status      text NOT NULL DEFAULT 'PENDING',         -- PENDING | APPROVED | REJECTED | EXPIRED
  payload     jsonb,                                   -- computed promise basis, or ASSR SLA breach detail
  summary     text,                                    -- human one-liner shown on the console
  created_at  text NOT NULL DEFAULT (now()::text),     -- ISO string
  decided_at  text,
  decided_by  text,                                    -- users.id as text, or 'AGENT_AUTO'
  CONSTRAINT chk_cs_agent_proposal_status
    CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED'))
);

-- Console list reads newest PENDING first; the engine's dedupe probe reads
-- (kind, key) over PENDING rows; the status card groups PENDING by kind.
CREATE INDEX IF NOT EXISTS idx_cs_agent_proposals_status
  ON cs_agent_proposals (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cs_agent_proposals_key
  ON cs_agent_proposals (kind, key, status);

CREATE TABLE IF NOT EXISTS cs_agent_briefs (
  id          text PRIMARY KEY,                        -- crypto.randomUUID()
  brief       jsonb NOT NULL,                          -- CsBriefData snapshot
  ai_focus    text,                                    -- brain-written paragraph; NULL until the lead's LLM pass
  created_at  text NOT NULL DEFAULT (now()::text)      -- ISO string
);

CREATE INDEX IF NOT EXISTS idx_cs_agent_briefs_created
  ON cs_agent_briefs (created_at DESC);
