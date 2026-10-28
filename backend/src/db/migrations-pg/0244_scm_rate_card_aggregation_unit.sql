-- 0244 — `aggregation` becomes what the tier ladder COUNTS, and gains the two
-- values that were missing.
--
-- WHY. Owner, 2026-08-02, describing all three modes in the same shape:
--   "Per drop point：一张 DO 多少钱?"
--   "Per customer：那一天如果是一样的顾客、一样的地址，是多少钱?"
--   "整趟的话，那就不看你多少张单了... 我 assign 给你一个 trip 就是多少钱"
-- Three answers to "how much per X". So the setting names X — the unit the
-- positional-tier ladder counts.
--
-- And the worked example that pins it down:
--   "他平时送一张单是 100 元，送 5 张单就是 500 元。但如果他跑柔佛，我们会额外
--    补贴 500 元... 总共是 1000 元."
-- Five DROPS at RM100, not five sets. The ladder must be able to count drops.
--
-- TWO NEW VALUES:
--   UNIT — count SETS or ITEMS (per `basis`). This is the ONLY behaviour the
--          calculator has ever had, and it had no name; every card said DROP or
--          CUSTOMER while the code counted sets regardless.
--   TRIP — count 1. One trip is one charging unit, so tier 1 IS the flat
--          trip price. "不看你多少张单" falls straight out.
--
-- THIS CHANGES WHAT 'DROP' AND 'CUSTOMER' MEAN. They used to be inert labels —
-- computeDeliveryCost never read the field at all (the calculator's own comment
-- admitted it: "Carried for the caller's fact aggregation"). From here they
-- select the count.
--
-- WHY THAT IS SAFE TODAY, checked rather than assumed: no rate card in this
-- database carries a single rule. Both existing cards read "0 rules" in the
-- live UI, so nothing is priced by any card and no invoice figure can move.
-- Existing rows keep their stored value; the default for NEW cards becomes
-- UNIT, which is the computation that has always run.
--
-- Nothing is backfilled. Changing a stored DROP to UNIT would assert the owner
-- meant per-set when the label said per-drop — the opposite of what this
-- migration exists to fix.
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified. RE-CHECK THE NUMBER AT
-- MERGE — 0244 was next free above 0243.

SET search_path = scm, public;

ALTER TABLE scm.delivery_rate_cards
  DROP CONSTRAINT IF EXISTS delivery_rate_cards_aggregation_check;

ALTER TABLE scm.delivery_rate_cards
  ADD CONSTRAINT delivery_rate_cards_aggregation_check
  CHECK (aggregation IN ('UNIT', 'DROP', 'CUSTOMER', 'TRIP'));

-- New cards count sets/items unless told otherwise — the historic behaviour,
-- now under its own name instead of hiding behind 'DROP'.
ALTER TABLE scm.delivery_rate_cards
  ALTER COLUMN aggregation SET DEFAULT 'UNIT';
