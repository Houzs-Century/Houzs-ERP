-- 0097_pms_agent.sql — PMS (Roadshow / Project) Agent engine tables (companion
-- to 0091's agent-console runtime; consumed by services/agents/pms-agent.ts).
--
-- The owner: "PMS agent 就是 roadshow/project agent." It has two jobs, kept on
-- opposite sides of a hard red line:
--
--   Job A — ANALYTICS BRIEF (READ-ONLY): a daily multi-dimensional sales cut of
--     the SCM sales-order header (by category / brand / state / salesperson /
--     venue, plus the salesperson-by-state cross that answers "who does
--     especially well where"). It writes NOTHING but one pms_agent_briefs
--     snapshot per run — it never proposes anything.
--     A PER-DIMENSION DATA-READINESS GATE rides along: salesperson_id / venue_id
--     are sparsely populated on historical SOs, so each dimension carries its
--     fill-rate and a `gated` flag ("coverage too low to trust — assign
--     salespeople / venues first"). The rows are still surfaced, never dropped.
--
--   Job B — PROJECT-LIFECYCLE CHASE (PROPOSAL-ONLY): a confirmed/active project
--     whose end_date is past but whose stage was never advanced to teardown /
--     closed / cancelled becomes a PROJECT_CHASE proposal. Approving it marks it
--     ready for the office to chase the closeout — this engine never edits a
--     project or contacts anyone.
--
--   pms_agent_proposals  PENDING PROJECT_CHASE rows (one per overdue-but-open
--                        project); `key` = 'PROJECT_CHASE:<code or name>', the
--                        dedupe so a project already on the worklist is never
--                        duplicated. payload carries the project's stage/status/
--                        end-date/days-overdue/venue/state.
--   pms_agent_briefs     one snapshot per run (deterministic analytics JSON);
--                        ai_focus is written LATER by the shared agent brain
--                        (nullable — the engine never calls the LLM itself).
--
-- HOUZS HOUSE STYLE (0091 / 0092 / 0094 precedent): no runtime self-apply (Houzs
-- migrates-before-deploy), text ids + text ISO timestamps, PUBLIC schema
-- (org-wide agent runtime, not SCM data), jsonb snapshots. Plain statements only
-- (pg-migrate splits on ';\n'); idempotent so the CI re-run is a no-op.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS pms_agent_proposals (
  id          text PRIMARY KEY,                        -- crypto.randomUUID()
  kind        text NOT NULL,                           -- PROJECT_CHASE
  key         text NOT NULL,                           -- dedupe key, e.g. 'PROJECT_CHASE:RS-2026-01'
  status      text NOT NULL DEFAULT 'PENDING',         -- PENDING | APPROVED | REJECTED | EXPIRED
  payload     jsonb,                                   -- project stage/status/end-date/days-overdue
  summary     text,                                    -- human one-liner shown on the console
  created_at  text NOT NULL DEFAULT (now()::text),     -- ISO string
  decided_at  text,
  decided_by  text,                                    -- users.id as text, or 'AGENT_AUTO'
  CONSTRAINT chk_pms_agent_proposal_status
    CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED'))
);

-- Console list reads newest PENDING first; the engine's dedupe probe reads
-- (kind, key) over PENDING rows; the status card groups PENDING by kind.
CREATE INDEX IF NOT EXISTS idx_pms_agent_proposals_status
  ON pms_agent_proposals (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pms_agent_proposals_key
  ON pms_agent_proposals (kind, key, status);

CREATE TABLE IF NOT EXISTS pms_agent_briefs (
  id          text PRIMARY KEY,                        -- crypto.randomUUID()
  brief       jsonb NOT NULL,                          -- PmsBriefData snapshot
  ai_focus    text,                                    -- brain-written paragraph; NULL until the lead's LLM pass
  created_at  text NOT NULL DEFAULT (now()::text)      -- ISO string
);

CREATE INDEX IF NOT EXISTS idx_pms_agent_briefs_created
  ON pms_agent_briefs (created_at DESC);
