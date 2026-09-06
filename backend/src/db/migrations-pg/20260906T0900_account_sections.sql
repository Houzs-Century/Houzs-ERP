-- 20260906T0900_account_sections.sql
-- REVERSAL: ALTER TABLE scm.accounts DROP COLUMN IF EXISTS section;
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   One nullable text column on scm.accounts, then an UPDATE that fills it for
--   every existing row by the code-range rule below. No row is inserted or
--   deleted, no other column moves, no constraint is added: every reader that
--   does not name the column keeps working, and the reversal is one DROP.
--
-- WHY (owner, 2026-09-06, his AutoCount screenshot in hand): chart of account
-- 每个 account type 的 header 能做吗 … 你先帮我分类,然后我自己还能调动(用拖拉式).
-- The SECTION is the top node his accountant's chart hangs every account
-- under (CAPITAL, CURRENT ASSETS, COST OF GOODS SOLD …); it decides the
-- five-way account_type, the chart page renders it as the header row, and the
-- owner moves accounts between sections by dragging. The import used the
-- headings only to derive the type and dropped them — this seeds them back
-- from the code ranges his chart already follows, once. After this, the
-- column is HIS: the API writes it on create/import/drag, never this rule.
--
-- The CASE mirrors defaultSectionFor in backend/src/scm/lib/account-sections.ts
-- (the vocabulary's one home) — change one, change both. Text comparison on
-- 'NNN-XXXX' orders by the three-digit prefix exactly as the numbers do.

ALTER TABLE scm.accounts ADD COLUMN IF NOT EXISTS section text;

UPDATE scm.accounts SET section = CASE
  WHEN account_type = 'EQUITY'    AND account_code <  '150' THEN 'CAPITAL'
  WHEN account_type = 'EQUITY'                              THEN 'RETAINED EARNING'
  WHEN account_type = 'ASSET'     AND account_code >= '200' AND account_code < '210' THEN 'FIXED ASSETS'
  WHEN account_type = 'ASSET'     AND account_code >= '210' AND account_code < '300' THEN 'OTHER ASSETS'
  WHEN account_type = 'ASSET'                               THEN 'CURRENT ASSETS'
  WHEN account_type = 'LIABILITY' AND account_code >= '460' AND account_code < '470' THEN 'LONG TERM LIABILITIES'
  WHEN account_type = 'LIABILITY' AND account_code >= '470' THEN 'OTHER LIABILITIES'
  WHEN account_type = 'LIABILITY'                           THEN 'CURRENT LIABILITIES'
  WHEN account_type = 'INCOME'    AND account_code <  '510' THEN 'SALES'
  WHEN account_type = 'INCOME'    AND account_code <  '530' THEN 'SALES ADJUSTMENTS'
  WHEN account_type = 'INCOME'    AND account_code >= '800' AND account_code < '900' THEN 'EXTRA-ORDINARY INCOME'
  WHEN account_type = 'INCOME'                              THEN 'OTHER INCOMES'
  WHEN account_type = 'EXPENSE'   AND account_code <  '700' THEN 'COST OF GOODS SOLD'
  WHEN account_type = 'EXPENSE'   AND account_code >= '950' AND account_code < '960' THEN 'TAXATION'
  ELSE 'EXPENSES'
END
WHERE section IS NULL;

-- A child sits where its header sits (子户跟着 header 走): four passes cover
-- the deepest tree the chart carries (depth ≤ 4 everywhere the API walks).
UPDATE scm.accounts c SET section = p.section
  FROM scm.accounts p
  WHERE p.company_id = c.company_id AND p.account_code = c.parent_code
    AND c.section IS DISTINCT FROM p.section;
UPDATE scm.accounts c SET section = p.section
  FROM scm.accounts p
  WHERE p.company_id = c.company_id AND p.account_code = c.parent_code
    AND c.section IS DISTINCT FROM p.section;
UPDATE scm.accounts c SET section = p.section
  FROM scm.accounts p
  WHERE p.company_id = c.company_id AND p.account_code = c.parent_code
    AND c.section IS DISTINCT FROM p.section;
UPDATE scm.accounts c SET section = p.section
  FROM scm.accounts p
  WHERE p.company_id = c.company_id AND p.account_code = c.parent_code
    AND c.section IS DISTINCT FROM p.section;
