-- 20261126T1430_acc_autocount_deposit_sales_account.sql
--
-- WHY. AutoCount counted the deposits it took as deposit sales at each month
-- end and booked 34% of them as cost (owner 2026-11-25); the ERP's sales
-- invoice counts the whole order as sales again. At the order's invoice the
-- AutoCount deposit note (acc/autocount-deposits.ts) takes the deposit back
-- out of sales — the owner, 2026-11-26: 「从sales 扣回来，但是是开cn 的方式吧，
-- account 不要放在sales 那边一起」 — so it books on an account of its own in the
-- SALES ADJUSTMENTS section, beside RETURN INWARDS and DISCOUNT ALLOWED, never
-- on the SALES accounts (509-0000 sits under SALES in the P&L).
--
-- WHAT THIS CHANGES.
-- 1. Houzs Century's chart gains 511-0000 DEPOSIT SALES BOOKED IN AUTOCOUNT:
--    INCOME, section SALES ADJUSTMENTS, no parent, active, no money flag — the
--    shape of 510-0000 / 520-0000. Only Houzs carries AutoCount money (2990 has
--    no imported payment). ON CONFLICT leaves an existing row exactly as it is.
-- 2. The P&L layout (scm.acc_report_layouts 'pnl', one tree for both
--    companies) lists it under its SALES ADJUSTMENTS category, last, when that
--    category is there and the tree does not name the account yet. Without
--    it the account would print under Unassigned in Trading income.
-- Nothing posts here; the code that books on the account ships in the same PR
-- and runs only after this file (pg-migrate runs before the Worker deploy).
--
-- Additive, idempotent, schema-qualified, no money. RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   Revert the code first. Then take the leaf out of the layout:
--     UPDATE scm.acc_report_layouts l
--        SET tree = jsonb_set(l.tree, '{blocks,tradingIncome}', (
--              SELECT jsonb_agg(CASE WHEN c.value->>'id' = 'sec:SALES ADJUSTMENTS'
--                                    THEN jsonb_set(c.value, '{children}', COALESCE((
--                                           SELECT jsonb_agg(k.value ORDER BY k.ordinality)
--                                             FROM jsonb_array_elements(c.value->'children') WITH ORDINALITY AS k(value, ordinality)
--                                            WHERE k.value->>'code' IS DISTINCT FROM '511-0000'), '[]'::jsonb))
--                                    ELSE c.value END ORDER BY c.ordinality)
--                FROM jsonb_array_elements(l.tree->'blocks'->'tradingIncome') WITH ORDINALITY AS c(value, ordinality)))
--      WHERE l.report = 'pnl' AND jsonb_typeof(l.tree->'blocks'->'tradingIncome') = 'array';
--   and the account, while no journal line names it:
--     DELETE FROM scm.accounts a WHERE a.company_id = 1 AND a.account_code = '511-0000'
--        AND NOT EXISTS (SELECT 1 FROM scm.journal_entry_lines l WHERE l.company_id = 1 AND l.account_code = '511-0000');
--   Once a note has booked on it, deactivate it instead (UPDATE scm.accounts SET is_active = false ...).
--   GRANTS: none to re-apply.

SET search_path = public, scm;

INSERT INTO scm.accounts (company_id, account_code, account_name, account_type, parent_code, is_active, acc_money, special_type, section)
SELECT c.id, '511-0000', 'DEPOSIT SALES BOOKED IN AUTOCOUNT', 'INCOME', NULL, true, false, NULL, 'SALES ADJUSTMENTS'
  FROM public.companies c
 WHERE c.code = 'HOUZS'
ON CONFLICT (company_id, account_code) DO NOTHING;

UPDATE scm.acc_report_layouts l
   SET tree = jsonb_set(l.tree, '{blocks,tradingIncome}', (
         SELECT jsonb_agg(CASE WHEN c.value->>'id' = 'sec:SALES ADJUSTMENTS'
                               THEN jsonb_set(c.value, '{children}',
                                      COALESCE(c.value->'children', '[]'::jsonb) || '[{"code": "511-0000", "kind": "account"}]'::jsonb)
                               ELSE c.value END ORDER BY c.ordinality)
           FROM jsonb_array_elements(l.tree->'blocks'->'tradingIncome') WITH ORDINALITY AS c(value, ordinality))),
       updated_at = now(),
       updated_by = 'migration 20261126T1430 (AutoCount deposit sales account)'
 WHERE l.report = 'pnl'
   AND jsonb_typeof(l.tree->'blocks'->'tradingIncome') = 'array'
   AND position('"511-0000"' IN l.tree::text) = 0
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(l.tree->'blocks'->'tradingIncome') AS c(value)
                WHERE c.value->>'id' = 'sec:SALES ADJUSTMENTS');
