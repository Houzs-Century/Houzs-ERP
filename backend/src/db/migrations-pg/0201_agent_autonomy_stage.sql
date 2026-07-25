-- 0201_agent_autonomy_stage.sql — stored 3-position autonomy dial + per-agent
-- ceiling on agent_controls. Supersedes the binary auto_approve (0091): a stored
-- stage (1 propose / 2 auto-tune + self-approve reversible actions within policy /
-- 3 full-auto) is clamped by a per-family max_stage the dial can NEVER raise.
--
-- SAFE DEFAULT = PRESERVES TODAY:
--   * stage default 1 (= today's auto_approve=0, propose-only).
--   * backfill stage=2 for any row already toggled auto_approve=1.
--   * max_stage default 2 for every family — Stage 3 (closed-loop automation) is a
--     deliberate LATER migration, never a console click. The money/comms families
--     (CS, COLLECTION, PROCUREMENT) stay permanently capped at 2.
--   * the auto_approve column is KEPT (isAutoApproveOn stays valid, now derived
--     from stage>=2); drop it only once no caller reads it.
-- Range + ceiling are enforced in the APP (effectiveStage + setAgentControl clamp
-- on read and write), so there are no CHECK constraints here — that keeps this
-- migration additive + idempotent (plain statements, no PL/pgSQL).
--
-- PUBLIC schema, 0091_agent_console.sql house style: integer columns.

SET search_path = public, scm;

ALTER TABLE agent_controls ADD COLUMN IF NOT EXISTS stage     integer NOT NULL DEFAULT 1;
ALTER TABLE agent_controls ADD COLUMN IF NOT EXISTS max_stage integer NOT NULL DEFAULT 2;

-- Preserve today's behaviour for any family already toggled on.
UPDATE agent_controls SET stage = 2 WHERE auto_approve = 1 AND stage < 2;

-- Pin every family's ceiling explicitly (per-family rows are otherwise created
-- lazily by setAgentControl). max_stage is set ONLY here / by migration — never
-- by the stage dial — so the money/comms families stay capped. The ON CONFLICT
-- touches ONLY max_stage, so the stage backfill above is not clobbered.
INSERT INTO agent_controls (agent, paused, auto_approve, stage, max_stage, updated_at) VALUES
  ('OF',          0, 0, 1, 2, now()::text),
  ('DELIVERY',    0, 0, 1, 2, now()::text),
  ('CS',          0, 0, 1, 2, now()::text),
  ('COLLECTION',  0, 0, 1, 2, now()::text),
  ('PROCUREMENT', 0, 0, 1, 2, now()::text),
  ('PMS',         0, 0, 1, 2, now()::text),
  ('SI',          0, 0, 1, 2, now()::text),
  ('DOCUMENT',    0, 0, 1, 2, now()::text)
ON CONFLICT (agent) DO UPDATE SET max_stage = EXCLUDED.max_stage;
