-- 0133_si_agent.sql — Sales & Commercial Intelligence Agent (HZS-SI-006) tables.
--
-- Owner 2026-07-18: "基本上就是 PMS 的看 PMS，然后还有看我们的 Sales Order" — the
-- agent reads the Sales Orders (and their venue dimension, which is the roadshow /
-- PMS view) and turns them into a management scorecard + an anomaly list.
--
-- Spec §8: sales / margin / conversion analysis, discount leakage, unusual
-- cancellation, low-margin bundles. §8.6 forbids it setting price, discount or
-- commission — so it is READ-ONLY over the business and writes ONLY these two
-- public-schema tables, exactly like the Document and OF agents.
--
-- FINDINGS = the anomaly list (one OPEN row per subject), auto-resolved when the
-- anomaly clears. BRIEFS = one scorecard snapshot per run.
--
-- HOUSE STYLE (0091/0093/0130): no runtime self-apply, IF NOT EXISTS, plain
-- statements, public schema, text ids + ISO-string timestamps.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS si_agent_findings (
  id           text PRIMARY KEY,
  kind         text NOT NULL,                      -- NEGATIVE_MARGIN | HIGH_CANCELLATION
  severity     text NOT NULL DEFAULT 'WARN',        -- INFO | WARN | CRIT
  subject      text NOT NULL,                       -- the SO doc_no, or the agent/venue name
  subject_type text NOT NULL DEFAULT 'ORDER',       -- ORDER | SALESPERSON | VENUE
  metric       text,                                -- the number that tripped it, human-readable
  summary      text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'OPEN',        -- OPEN | RESOLVED
  created_at   text NOT NULL,
  last_seen_at text NOT NULL,
  resolved_at  text
);

-- At most one OPEN finding per (kind, subject) — a patrol refreshes in place.
CREATE UNIQUE INDEX IF NOT EXISTS uq_si_agent_findings_open
  ON si_agent_findings (kind, subject) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS idx_si_agent_findings_status
  ON si_agent_findings (status, severity, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS si_agent_briefs (
  id           text PRIMARY KEY,
  generated_at text NOT NULL,
  brief        jsonb NOT NULL,
  ai_focus     text
);

CREATE INDEX IF NOT EXISTS idx_si_agent_briefs_generated
  ON si_agent_briefs (generated_at DESC);
