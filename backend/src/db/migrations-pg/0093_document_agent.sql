-- 0093_document_agent.sql — Document Agent patrol tables (Phase 1 of the
-- Houzs agent fleet; companion to 0091_agent_console.sql runtime tables).
--
--   document_agent_findings  one OPEN row per (kind, doc_type, doc_id) the
--                            daily document-flow patrol found wrong: delivered
--                            DO with no invoice, stuck SO, stale DRAFT, unpaid
--                            SI (collection aging), GRN with no PI, payment
--                            mismatch. The patrol auto-RESOLVES a finding when
--                            its condition no longer holds — findings are the
--                            agent's living worklist, not an append-only log.
--   document_agent_briefs    one snapshot per collectDocumentBrief() run: the
--                            daily brief JSON (open counts by kind/severity,
--                            top-10 urgent, collection aging totals in sen).
--
-- The engine (services/agents/document-agent.ts) is READ-ONLY over business
-- documents — these two tables are the ONLY thing it writes.
--
-- HOUZS CONVENTIONS (matches 0091):
--   * Tables live in PUBLIC (agent runtime is org-wide, not SCM).
--   * Timestamps TEXT (ISO strings) — public-schema house style.
--   * Plain statements only (pg-migrate splits on ';' end-of-line — no
--     PL/pgSQL bodies). Idempotent (IF NOT EXISTS) so the CI auto-apply
--     re-run is a no-op.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS document_agent_findings (
  id           text PRIMARY KEY,                      -- crypto.randomUUID()
  kind         text NOT NULL,                         -- INVOICE_GAP | STUCK_SO | STALE_DRAFT | UNPAID_SI | GRN_NO_PI | PAYMENT_MISMATCH
  severity     text NOT NULL DEFAULT 'WARN',          -- INFO | WARN | CRIT
  doc_type     text NOT NULL,                         -- SO | DO | SI | PO | GRN | PI
  doc_id       text NOT NULL,                         -- SO doc_no, else the row uuid as text
  doc_no       text,                                  -- human document number for the console
  summary      text NOT NULL,                         -- one plain-English sentence
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,    -- detector detail (money in integer sen)
  status       text NOT NULL DEFAULT 'OPEN',          -- OPEN | RESOLVED
  created_at   text NOT NULL,                         -- ISO string, first seen
  last_seen_at text NOT NULL,                         -- ISO string, refreshed each patrol
  resolved_at  text                                   -- ISO string once auto-closed
);

-- The dedupe contract: at most ONE OPEN finding per (kind, doc). A resolved
-- finding whose condition recurs gets a fresh row (history stays visible).
CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_agent_findings_open_dedupe
  ON document_agent_findings (kind, doc_type, doc_id) WHERE status = 'OPEN';

-- Patrol reload ("all OPEN"), console filters (status+kind+severity) and the
-- brief's oldest-CRIT-first ordering.
CREATE INDEX IF NOT EXISTS idx_doc_agent_findings_status_kind
  ON document_agent_findings (status, kind, severity);

CREATE INDEX IF NOT EXISTS idx_doc_agent_findings_created
  ON document_agent_findings (created_at DESC);

CREATE TABLE IF NOT EXISTS document_agent_briefs (
  id           text PRIMARY KEY,                      -- crypto.randomUUID()
  generated_at text NOT NULL,                         -- ISO string
  brief        jsonb NOT NULL                         -- the full DocumentBrief snapshot
);

CREATE INDEX IF NOT EXISTS idx_doc_agent_briefs_generated
  ON document_agent_briefs (generated_at DESC);
