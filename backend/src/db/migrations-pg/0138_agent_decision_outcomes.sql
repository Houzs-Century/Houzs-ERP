-- 0138_agent_decision_outcomes.sql — close the loop the spec asks for (§9.1:
-- "Track whether approved actions were executed and whether the expected result
-- occurred; open a recovery task when verification fails").
--
-- WHY A TABLE AND NOT THE EXISTING COLUMN. agent_decisions already has an
-- `outcome text` column, and nothing has ever filled it — because that table is
-- APPEND-ONLY by intent (0135: "a decision that turned out wrong is answered with a
-- NEW row, never by editing the old one") and there is no update path in the code.
-- Filling `outcome` later would mean editing a decision after the fact, which is
-- exactly the property that makes the trail worth keeping. So an outcome is its own
-- row, pointing back at the decision.
--
-- That also lets one decision accrue SEVERAL observations over time — executed
-- now, verified an hour later, contradicted next week — which is what "did the
-- expected result actually occur" needs. A single column can hold only the last
-- word, and the last word is usually the least interesting one.
--
-- WHAT THIS IS NOT: it does not promote anything. The spec's Stage 1→2→3 ladder
-- (§10.5) stays a HUMAN decision; this only accumulates the evidence a human would
-- want before making it. No agent's authority changes because a table exists.
--
-- HOUSE STYLE (0130/0133/0135): additive, IF NOT EXISTS, plain statements, public
-- schema, text ids + ISO-string timestamps, no runtime self-apply.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS agent_decision_outcomes (
  id           text PRIMARY KEY,
  decision_id  text NOT NULL,          -- agent_decisions.id
  agent        text NOT NULL,          -- denormalised so promotion evidence is one read
  -- EXECUTED   — the approved action was actually carried out
  -- FAILED     — it was attempted and did not complete
  -- VERIFIED   — the expected RESULT was observed afterwards (the §9.1 second half)
  -- CONTRADICTED — the result was observed and it was NOT what was predicted
  -- SKIPPED    — approved but deliberately not carried out
  kind         text NOT NULL,
  detail       text,
  -- Set when kind = CONTRADICTED/FAILED and a recovery task was opened, so an
  -- unrecovered failure is distinguishable from one nobody looked at.
  recovery_ref text,
  observed_at  text NOT NULL,
  observed_by  text                    -- user id, or 'AGENT_AUTO'
);

CREATE INDEX IF NOT EXISTS idx_agent_decision_outcomes_decision
  ON agent_decision_outcomes (decision_id, observed_at DESC);

-- Promotion evidence is asked per agent over a window; this is that read.
CREATE INDEX IF NOT EXISTS idx_agent_decision_outcomes_agent
  ON agent_decision_outcomes (agent, observed_at DESC);
