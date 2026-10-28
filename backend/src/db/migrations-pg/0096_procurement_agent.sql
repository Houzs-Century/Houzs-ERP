-- 0096_procurement_agent.sql — Procurement Agent engine tables (companion to
-- 0091's agent-console runtime; consumed by services/agents/procurement-agent.ts).
--
-- The Procurement Agent is the MRP-driven reorder chaser the owner asked for as
-- the HOOKKA flow: "run MRP, then propose POs to suppliers." It runs the SAME
-- allocation the SCM MRP page uses, applies a supplier-coverage readiness gate,
-- and — only when coverage is high enough — groups the shortage SKUs by main
-- supplier into one REORDER proposal each, plus a daily shortage brief.
--
-- PROPOSAL-ONLY RED LINE: this engine NEVER creates or edits an
-- scm.purchase_orders row. Its proposals live here, in procurement_agent_proposals
-- (public schema) — which is exactly why MRP never double-counts them: MRP's
-- supply calc reads only real, non-DEAD scm POs, so a pending reorder (a pre-PO
-- record) can't leak back into the next run's poOutstanding. On approval the
-- office raises the real PO through the existing SO->PO converter. Auto-send by
-- email / WhatsApp is a documented later step, not in this engine.
--
--   procurement_agent_proposals  PENDING REORDER rows (one per supplier with
--                                shortage SKUs); `key` = 'REORDER:<supplierCode>',
--                                the dedupe so a supplier already on the worklist
--                                is never duplicated. payload lists that
--                                supplier's shortage SKUs with quantities + the
--                                earliest order-by date (no cost — MrpSku carries
--                                none; cost/value is a later enhancement).
--   procurement_agent_briefs     one snapshot per run (deterministic shortage /
--                                coverage / reorder-by-supplier brief JSON);
--                                ai_focus is written LATER by the shared agent
--                                brain (nullable — the engine never calls the LLM).
--
-- HOUZS HOUSE STYLE (0091 / 0092 / 0094 precedent): no runtime self-apply (Houzs
-- migrates-before-deploy), text ids + text ISO timestamps, PUBLIC schema (org-wide
-- agent runtime, not SCM data), jsonb snapshots. Plain statements only (pg-migrate
-- splits on ';\n'); idempotent so the CI re-run is a no-op.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS procurement_agent_proposals (
  id          text PRIMARY KEY,                        -- crypto.randomUUID()
  kind        text NOT NULL,                           -- REORDER
  key         text NOT NULL,                           -- dedupe key, e.g. 'REORDER:SUP-001'
  status      text NOT NULL DEFAULT 'PENDING',         -- PENDING | APPROVED | REJECTED | EXPIRED
  payload     jsonb,                                   -- supplier's shortage SKUs + quantities + earliest order-by date
  summary     text,                                    -- human one-liner shown on the console
  created_at  text NOT NULL DEFAULT (now()::text),     -- ISO string
  decided_at  text,
  decided_by  text,                                    -- users.id as text, or 'AGENT_AUTO'
  CONSTRAINT chk_procurement_agent_proposal_status
    CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED'))
);

-- Console list reads newest PENDING first; the engine's dedupe probe reads
-- (kind, key) over PENDING rows; the status card counts PENDING rows.
CREATE INDEX IF NOT EXISTS idx_procurement_agent_proposals_status
  ON procurement_agent_proposals (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_procurement_agent_proposals_key
  ON procurement_agent_proposals (kind, key, status);

CREATE TABLE IF NOT EXISTS procurement_agent_briefs (
  id          text PRIMARY KEY,                        -- crypto.randomUUID()
  brief       jsonb NOT NULL,                          -- ProcurementBriefData snapshot
  ai_focus    text,                                    -- brain-written paragraph; NULL until the lead's LLM pass
  created_at  text NOT NULL DEFAULT (now()::text)      -- ISO string
);

CREATE INDEX IF NOT EXISTS idx_procurement_agent_briefs_created
  ON procurement_agent_briefs (created_at DESC);
