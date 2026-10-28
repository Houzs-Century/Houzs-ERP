-- 20260915T1400_acc_account_balances_count_the_books.sql
-- REVERSAL: CREATE OR REPLACE VIEW scm.v_account_balances AS <the definition
--   migration 0306_gl_views_join_on_company.sql carries, verbatim — it is the
--   one live today, reproduced at the foot of this file>. A view holds no
--   data, so nothing is lost either way. GRANTS: none touched — this is a
--   REPLACE, the ACL stays.
--
-- THE TRIAL BALANCE COUNTED EVERY DRAFT AND BOTH SIDES OF EVERY REVERSAL.
--
-- scm.v_account_balances is what GET /accounting/balances reads — the Trial
-- Balance tab and its "books balance" self-check. Its predicate
--
--     LEFT JOIN scm.journal_entries j
--       ON j.id = l.journal_entry_id AND j.posted = true AND j.reversed = false
--
-- sits in the ON of a LEFT JOIN while the SUM runs over the LINES (l). A line
-- whose journal fails the predicate is not dropped: its j-side is NULL and its
-- debit and credit are summed all the same. Migrations 0290 and 0306 both saw
-- this, judged it a pending owner decision, and left it (docs/audit-2026-08-13-
-- ledger.md). Measured on 2990 HOME on 2026-09-15, before this migration:
--
--   · 14 lines of UNPOSTED drafts in the totals — RM 11,980.00 of draft debits
--     on 300-0000 alone;
--   · both sides of 65 reversal pairs — 330-0000 read Dr 194,438.70 /
--     Cr 194,438.70 where the books it counts hold Dr 137,524.10 / Cr
--     137,524.10; 28 accounts carried a gross that no statement carries.
--
-- The balances net (a pair sums to zero), so the self-check stayed green while
-- every gross was wrong and every draft counted.
--
-- OWNER DECISION 2026-09-15 (docs/bugs/0923): 照理就是对冲掉，所以都不应该显示，
-- je 可以留记录就好 — a reversed journal and the contra that undid it are one
-- correction; the journal keeps both, the books show neither. Every reader
-- now applies one predicate (backend/src/acc/reversal-pairs.ts):
--
--     posted = true AND reversed = false AND reversed_by_je IS NULL
--
-- `reversed` marks the original; `reversed_by_je` links BOTH sides (the
-- original to its contra, the contra back to the original — acc/engine.ts
-- reverseJournal). This view is the one reader that lives in the database,
-- so it takes the predicate here.
--
-- WHAT CHANGES. The lines are chosen BEFORE the LEFT JOIN — a subquery of the
-- lines the books count, joined to the chart on the composite key 0306
-- established. An account with nothing to count still comes back at zero
-- (the LEFT JOIN is kept for that), so the Trial Balance keeps listing the
-- whole chart.
--
-- SHAPE. CREATE OR REPLACE VIEW may only append columns; not one column is
-- added, removed, renamed, retyped or reordered here — the seven of 0306 in
-- 0306's order. backend/tests-pg/accountBalancesCountTheBooks.pg.test.ts
-- captures the column list from the live definition, applies this file on
-- top and compares. The same test seeds a draft and a reversal pair, proves
-- the live view counts them, and proves this one does not.
--
-- Verified against: staging minnapsemfzjmtvnnvdd (apply_migration) — the
-- view replaced in place, columns unchanged, and for 2990 HOME every account's
-- total_debit_sen / total_credit_sen equals the sum over posted, pairless lines.

SET search_path = scm, public;

CREATE OR REPLACE VIEW scm.v_account_balances AS
 SELECT a.account_code,
    a.account_name,
    a.account_type,
    COALESCE(sum(l.debit_sen), 0::bigint) AS total_debit_sen,
    COALESCE(sum(l.credit_sen), 0::bigint) AS total_credit_sen,
        CASE
            WHEN a.account_type = ANY (ARRAY['ASSET'::text, 'EXPENSE'::text]) THEN COALESCE(sum(l.debit_sen), 0::bigint) - COALESCE(sum(l.credit_sen), 0::bigint)
            ELSE COALESCE(sum(l.credit_sen), 0::bigint) - COALESCE(sum(l.debit_sen), 0::bigint)
        END AS balance_sen,
    a.company_id
   FROM scm.accounts a
     -- The lines the books count, chosen BEFORE the outer join: posted, and on
     -- neither side of a reversal pair. Put in the ON of the LEFT JOIN, as
     -- 0106 had it, the predicate only blanked the journal side and every
     -- line was summed regardless.
     LEFT JOIN (
       SELECT l.account_code, l.company_id, l.debit_sen, l.credit_sen
         FROM scm.journal_entry_lines l
         JOIN scm.journal_entries j ON j.id = l.journal_entry_id
        WHERE j.posted = true
          AND j.reversed = false
          AND j.reversed_by_je IS NULL
     ) l
       ON l.account_code = a.account_code
      AND l.company_id = a.company_id
  GROUP BY a.account_code, a.account_name, a.account_type, a.company_id
  ORDER BY a.account_code;

-- The definition this replaces (0306_gl_views_join_on_company.sql), for the
-- REVERSAL above:
--
--   CREATE OR REPLACE VIEW scm.v_account_balances AS
--    SELECT a.account_code, a.account_name, a.account_type,
--       COALESCE(sum(l.debit_sen), 0::bigint) AS total_debit_sen,
--       COALESCE(sum(l.credit_sen), 0::bigint) AS total_credit_sen,
--           CASE
--               WHEN a.account_type = ANY (ARRAY['ASSET'::text, 'EXPENSE'::text]) THEN COALESCE(sum(l.debit_sen), 0::bigint) - COALESCE(sum(l.credit_sen), 0::bigint)
--               ELSE COALESCE(sum(l.credit_sen), 0::bigint) - COALESCE(sum(l.debit_sen), 0::bigint)
--           END AS balance_sen,
--       a.company_id
--      FROM scm.accounts a
--        LEFT JOIN scm.journal_entry_lines l
--          ON l.account_code = a.account_code
--         AND l.company_id = a.company_id
--        LEFT JOIN scm.journal_entries j ON j.id = l.journal_entry_id AND j.posted = true AND j.reversed = false
--     GROUP BY a.account_code, a.account_name, a.account_type, a.company_id
--     ORDER BY a.account_code;
