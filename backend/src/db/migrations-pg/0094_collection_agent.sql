-- 0094_collection_agent.sql — Collection Agent engine tables (companion to
-- 0091's agent-console runtime; consumed by services/agents/collection-agent.ts).
--
-- The Collection Agent is the accounts-receivable chaser the owner asked for as
-- its OWN family (not folded into Document): it groups every unpaid sales
-- invoice by debtor into an actionable DEBTOR_CHASE proposal and keeps a daily
-- AR-aging brief. PROPOSAL-ONLY: approving a chase marks it ready for the
-- office / Mail Center to send — this engine never contacts a customer or
-- edits an invoice.
--
--   collection_agent_proposals  PENDING DEBTOR_CHASE rows (one per debtor with
--                               overdue AR); `key` = debtor handle, the dedupe
--                               so a debtor already on the worklist is never
--                               duplicated. payload lists that debtor's unpaid
--                               invoices with buckets + outstanding sen.
--   collection_agent_briefs     one snapshot per run (deterministic AR-aging
--                               brief JSON); ai_focus is written LATER by the
--                               shared agent brain (nullable — the engine never
--                               calls the LLM itself).
--
-- HOUZS HOUSE STYLE (0091 / 0092 precedent): no runtime self-apply (Houzs
-- migrates-before-deploy), text ids + text ISO timestamps, PUBLIC schema
-- (org-wide agent runtime, not SCM data), jsonb snapshots. Plain statements
-- only (pg-migrate splits on ';\n'); idempotent so the CI re-run is a no-op.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS collection_agent_proposals (
  id          text PRIMARY KEY,                        -- crypto.randomUUID()
  kind        text NOT NULL,                           -- DEBTOR_CHASE
  key         text NOT NULL,                           -- dedupe key, e.g. 'DEBTOR_CHASE:ACME SDN BHD'
  status      text NOT NULL DEFAULT 'PENDING',         -- PENDING | APPROVED | REJECTED | EXPIRED
  payload     jsonb,                                   -- debtor's unpaid invoices + buckets + totals
  summary     text,                                    -- human one-liner shown on the console
  created_at  text NOT NULL DEFAULT (now()::text),     -- ISO string
  decided_at  text,
  decided_by  text,                                    -- users.id as text, or 'AGENT_AUTO'
  CONSTRAINT chk_collection_agent_proposal_status
    CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED'))
);

-- Console list reads newest PENDING first; the engine's dedupe probe reads
-- (kind, key) over PENDING rows; the status card groups PENDING by kind.
CREATE INDEX IF NOT EXISTS idx_collection_agent_proposals_status
  ON collection_agent_proposals (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_collection_agent_proposals_key
  ON collection_agent_proposals (kind, key, status);

CREATE TABLE IF NOT EXISTS collection_agent_briefs (
  id          text PRIMARY KEY,                        -- crypto.randomUUID()
  brief       jsonb NOT NULL,                          -- CollectionBriefData snapshot
  ai_focus    text,                                    -- brain-written paragraph; NULL until the lead's LLM pass
  created_at  text NOT NULL DEFAULT (now()::text)      -- ISO string
);

CREATE INDEX IF NOT EXISTS idx_collection_agent_briefs_created
  ON collection_agent_briefs (created_at DESC);
