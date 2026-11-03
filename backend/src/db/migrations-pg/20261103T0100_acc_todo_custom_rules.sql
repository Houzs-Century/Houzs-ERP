-- 20261103T0100_acc_todo_custom_rules.sql
-- Finance's own To do rules (the owner's Claude Design redesign, batch 2c,
-- 2026-11-03): beside the built-in rules, Finance may add a rule from a
-- template — supplier bills due within N days, drafts left more than N days,
-- customer payments over RM N — and switch it off like any other.
--
-- [{"id": "c-…", "tpl": "bills" | "drafts" | "big", "param": N, "group": "pay" | …}]
-- An id switched off sits in rules_off beside the built-in ones.
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified. RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   ALTER TABLE scm.acc_todo_settings DROP COLUMN IF EXISTS custom_rules;

ALTER TABLE scm.acc_todo_settings ADD COLUMN IF NOT EXISTS custom_rules jsonb NOT NULL DEFAULT '[]'::jsonb;
