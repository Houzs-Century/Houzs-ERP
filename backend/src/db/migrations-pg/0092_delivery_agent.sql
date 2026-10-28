-- 0092_delivery_agent.sql — Delivery Agent engine tables (companion to 0091's
-- agent-console runtime; consumed by services/agents/delivery-agent.ts).
--
--   delivery_agent_proposals  PENDING rows the engine writes and the owner
--                             decides on the console: LOAD_PLAN (ready pool
--                             bucketed by region, one customer's orders
--                             grouped) and POD_CHASE (delivered >24h with no
--                             POD photo/signature). PROPOSAL-ONLY red line:
--                             approval never creates/dispatches DOs or trips.
--                             `key` is the dedupe handle — the engine never
--                             re-creates a PENDING row for the same kind+key.
--   delivery_agent_briefs     one snapshot per engine run (deterministic
--                             brief JSON); ai_focus is written LATER by the
--                             shared agent brain (nullable — the engine
--                             itself never calls the LLM).
--
-- HOUZS HOUSE STYLE (0058 / 0088 / 0091 precedent):
--   * No runtime self-apply — Houzs migrates-before-deploy; the engine
--     assumes these tables exist.
--   * text ids (crypto.randomUUID()) + text ISO timestamps.
--   * Tables live in PUBLIC (org-wide agent runtime, not SCM data).
--   * payload/brief are jsonb per the engine spec (queryable snapshots).
--
-- Plain statements only (pg-migrate splits on ';\n' — no PL/pgSQL bodies).
-- Idempotent (IF NOT EXISTS) so the CI auto-apply re-run is a no-op.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS delivery_agent_proposals (
  id          text PRIMARY KEY,                        -- crypto.randomUUID()
  kind        text NOT NULL,                           -- LOAD_PLAN | POD_CHASE
  key         text NOT NULL,                           -- dedupe key, e.g. 'LOAD_PLAN:SELANGOR' / 'POD_CHASE:DO-2607-0012'
  status      text NOT NULL DEFAULT 'PENDING',         -- PENDING | APPROVED | REJECTED | EXPIRED
  payload     jsonb,                                   -- grouped docs + counts (engine-written)
  summary     text,                                    -- human one-liner shown on the console
  created_at  text NOT NULL DEFAULT (now()::text),     -- ISO string
  decided_at  text,
  decided_by  text,                                    -- users.id as text, or 'AGENT_AUTO'
  CONSTRAINT chk_delivery_agent_proposal_status
    CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED'))
);

-- Console list reads newest PENDING first; the engine's dedupe probe reads
-- (kind, key) over PENDING rows; the status card groups PENDING by kind.
CREATE INDEX IF NOT EXISTS idx_delivery_agent_proposals_status
  ON delivery_agent_proposals (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_agent_proposals_kind
  ON delivery_agent_proposals (kind, status);

CREATE INDEX IF NOT EXISTS idx_delivery_agent_proposals_key
  ON delivery_agent_proposals (kind, key, status);

CREATE TABLE IF NOT EXISTS delivery_agent_briefs (
  id          text PRIMARY KEY,                        -- crypto.randomUUID()
  brief       jsonb NOT NULL,                          -- DeliveryBriefData snapshot
  ai_focus    text,                                    -- brain-written paragraph; NULL until the lead's LLM pass
  created_at  text NOT NULL DEFAULT (now()::text)      -- ISO string
);

-- The console card reads the newest snapshot (MAX(created_at) / latest row).
CREATE INDEX IF NOT EXISTS idx_delivery_agent_briefs_created
  ON delivery_agent_briefs (created_at DESC);
