-- 0104_document_agent_ai_focus.sql — give the Document Agent's daily brief the
-- same brain-written AI-focus paragraph every other family already has.
--
-- Migration 0093 created document_agent_briefs WITHOUT an ai_focus column (the
-- other five families' brief tables — 0092 delivery, 0094-0097 collection / cs
-- / procurement / pms — all carry one). The console lead's LLM pass writes ONE
-- short paragraph of judgment over the deterministic brief; NULL until it runs
-- (no key, over budget, or brain failure all fail open to NULL).
--
-- HOUZS CONVENTIONS (matches 0093):
--   * Table lives in PUBLIC (agent runtime is org-wide, not SCM).
--   * Plain statements only (pg-migrate splits on ';' end-of-line — no
--     PL/pgSQL bodies). Idempotent (ADD COLUMN IF NOT EXISTS) so the CI
--     auto-apply re-run is a no-op.

SET search_path = public, scm;

ALTER TABLE document_agent_briefs
  ADD COLUMN IF NOT EXISTS ai_focus text;   -- brain-written paragraph; NULL until the lead's LLM pass
