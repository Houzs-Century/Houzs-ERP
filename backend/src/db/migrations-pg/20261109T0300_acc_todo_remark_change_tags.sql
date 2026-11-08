-- 20261109T0300_acc_todo_remark_change_tags.sql
-- A To do task can be changed and deleted (owner 2026-11-09: 「这个我set 的task 不能
-- edit 资料，不能delete？」 → 可以). Each change, and the delete, leaves a line in the
-- task's thread that nobody can rewrite, so acc_todo_remarks.tag takes 'edit' and
-- 'deleted' beside 'done' and 'reopen'. The delete itself is the existing switch
-- (acc_todo_tasks.is_off): nothing is deleted.
--
-- The constraint's name is Postgres's own for the inline CHECK of 20261102T2100,
-- read on production 2026-11-09 (run 42503947964): acc_todo_remarks_tag_check,
-- CHECK (tag IS NULL OR tag = ANY (ARRAY['done', 'reopen'])). Rows then: 10 untagged,
-- 4 done, 1 reopen — all inside the wider check.
--
-- HOUSE STYLE. Idempotent, schema-qualified. RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL: only while no row carries 'edit' or 'deleted' —
--   ALTER TABLE scm.acc_todo_remarks DROP CONSTRAINT IF EXISTS acc_todo_remarks_tag_check;
--   ALTER TABLE scm.acc_todo_remarks ADD CONSTRAINT acc_todo_remarks_tag_check
--     CHECK (tag IS NULL OR tag IN ('done', 'reopen'));

ALTER TABLE scm.acc_todo_remarks DROP CONSTRAINT IF EXISTS acc_todo_remarks_tag_check;

ALTER TABLE scm.acc_todo_remarks ADD CONSTRAINT acc_todo_remarks_tag_check
  CHECK (tag IS NULL OR tag IN ('done', 'reopen', 'edit', 'deleted'));
