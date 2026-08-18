-- 0305 — the trial balance and the GL export were summing BOTH companies.
--
-- REVERSAL: re-run 0290's CREATE OR REPLACE block for scm.v_gl_entries and
-- 0106's for scm.v_account_balances. Both are preserved verbatim in those files
-- and a view holds no data, so nothing is lost either way.
--
-- WHAT WAS WRONG. Two report views join the chart of accounts on the account
-- CODE alone:
--
--   v_gl_entries        JOIN scm.accounts a ON a.account_code = l.account_code
--   v_account_balances  LEFT JOIN scm.journal_entry_lines l
--                            ON l.account_code = a.account_code
--
-- That was correct while account_code was globally unique. Migration 0188
-- ("accounts: UNIQUE(account_code) -> (company_id, account_code)") dropped the
-- single-column constraint and added
-- `accounts_company_account_code_unique UNIQUE (company_id, account_code)`,
-- precisely because a code is only unique WITHIN a company now. Neither view
-- was updated; both kept matching on the code half of a composite key.
--
-- It stayed harmless only while the two charts held different codes. Migration
-- 0297_acc_autocount_chart ("ONE AutoCount-style chart for every company",
-- owner decision 2026-08-16) inserted the 31-account template into company 1 to
-- match company 2. From that migration onward EVERY code exists in BOTH charts,
-- and the join is many-to-many:
--
--   · v_gl_entries — `a` matches two rows per line. Both duplicates carry the
--     SAME j.company_id, so a route-level .eq('company_id', …) cannot tell them
--     apart. Every posted journal line was returned TWICE.
--   · v_account_balances — a.company_id sits in the GROUP BY, which only LABELS
--     the bucket. The SUM ran over every line carrying that code in EITHER
--     company. Its own comment claims "each company's account balances stay
--     their own bucket"; this migration is what finally makes that true.
--
-- WHAT IT MEANT ON SCREEN. routes/accounting.ts GET /gl, /balances,
-- /control-check and /daily-bank. Trade Debtor, Trade Creditor, Inventory and
-- Sales Revenue read as one company PLUS the other, so both organisations
-- rendered effectively the same balance sheet. /control-check ties the GL back
-- to the documents, and its GL side was doubled, so it passed or failed for
-- arithmetic reasons rather than real ones.
--
-- SCALE, measured not assumed: 0297 recorded the ledger at 7 journal entries /
-- 14 lines on 2026-08-16, so the volume of mis-stated history is small. The
-- defect is in the view, not in stored rows — nothing needs backfilling, and
-- every figure corrects itself the moment this lands.
--
-- NOT A DESIGN TRADE-OFF. docs/MULTICOMPANY-SCALING.md records the chart of
-- accounts as SEPARATE per company, and corrects an older map that had listed
-- it shared. These two views were the last place still treating it as one chart.
--
-- SHAPE — and this is the part that has already cost one production deploy.
-- CREATE OR REPLACE VIEW may only APPEND columns: existing names, types and
-- ORDER must match the LIVE view exactly. 0290 was written against a stale
-- definition, renamed column 1, and failed in production with
-- `cannot change name of view column "line_id" to "journal_entry_id"` —
-- pg-migrate runs before wrangler, so the whole backend deploy stopped and
-- every later migration queued behind it.
--
-- So the SELECT lists below are copied VERBATIM from the definitions that are
-- live today — v_gl_entries from 0290, v_account_balances from 0106. Not one
-- column is added, removed, renamed or reordered. The ONLY edit in this file is
-- a company predicate on two JOINs. DROP VIEW + CREATE VIEW would be the
-- tempting repair and is the wrong one: a recreated view is a new object with
-- an EMPTY ACL, which is how 0189 took the Sales Order list down for every user
-- and needed 0190 and 0191 to put the grants back. Staying a REPLACE means no
-- privilege is dropped.
--
-- DELIBERATELY NOT CHANGED. v_account_balances puts `j.posted = true AND
-- j.reversed = false` in a LEFT JOIN ... ON while summing l.debit_sen, so lines
-- belonging to unposted or reversed entries still contribute to the totals.
-- 0290 examined that, judged it a separate question with a different answer
-- (it would move reported balances), and recorded it for the owner in
-- docs/audit-2026-08-13-ledger.md instead of changing it. That boundary is
-- respected here: this migration removes the cross-company leak and nothing
-- else. Fixing a provable leak must not smuggle in a pending owner decision.
--
-- Regression test: backend/tests-pg/glViewsScopeToCompany.pg.test.ts.

SET search_path = scm, public;

CREATE OR REPLACE VIEW scm.v_gl_entries AS
 SELECT l.id AS line_id,
    j.je_no,
    j.entry_date,
    j.source_type,
    j.source_doc_no,
    l.line_no,
    l.account_code,
    a.account_name,
    a.account_type,
    l.debit_sen,
    l.credit_sen,
    l.party_type,
    l.party_code,
    l.party_name,
    l.notes,
    j.posted,
    j.posted_at,
    j.company_id,
    j.reversed,
    j.reversed_by_je
   FROM scm.journal_entry_lines l
     JOIN scm.journal_entries j ON j.id = l.journal_entry_id
     -- BOTH halves of the composite key 0188 created. On account_code alone this
     -- matched the other company's identically-coded account and returned every
     -- line twice.
     JOIN scm.accounts a
       ON a.account_code = l.account_code
      AND a.company_id = j.company_id
  WHERE j.posted = true
  ORDER BY j.entry_date DESC, j.je_no DESC, l.line_no;

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
     -- scm.journal_entry_lines.company_id is NOT NULL since 0083, so this is a
     -- direct term and needs no detour through journal_entries. Without it the
     -- SUM pulled in the other company's lines while the GROUP BY labelled the
     -- bucket as ours.
     LEFT JOIN scm.journal_entry_lines l
       ON l.account_code = a.account_code
      AND l.company_id = a.company_id
     LEFT JOIN scm.journal_entries j ON j.id = l.journal_entry_id AND j.posted = true AND j.reversed = false
  GROUP BY a.account_code, a.account_name, a.account_type, a.company_id
  ORDER BY a.account_code;
