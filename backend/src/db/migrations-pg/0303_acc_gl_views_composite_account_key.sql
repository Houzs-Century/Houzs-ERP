-- 0303_acc_gl_views_composite_account_key.sql
--
-- THE GENERAL LEDGER WAS COUNTING EVERY POSTED LINE TWICE, AND EACH COMPANY'S
-- BALANCES CARRIED THE OTHER COMPANY'S LINES.
--
-- Measured on production 2026-08-18 before this migration: GET
-- /api/scm/accounting/gl for company 1 returned 12 rows holding 6 distinct
-- line_id values — every line exactly twice. Every non-zero figure on the GL
-- page, the control-account self-check (accounting.ts, `bal += debit - credit`)
-- and Daily Bank was therefore 2x.
--
-- Cause. Migration 0188 moved the accounts natural key from UNIQUE(account_code)
-- to UNIQUE(company_id, account_code) — correct, and it converted the three FKs
-- to composites for exactly this reason ("a per-company account code makes a
-- bare account_code FK ambiguous — which company's 200-0000?"). Two views kept
-- joining on the bare code:
--
--     v_gl_entries      0290:110  JOIN scm.accounts a ON a.account_code = l.account_code
--     v_account_balances 0106:74  LEFT JOIN scm.journal_entry_lines l ON l.account_code = a.account_code
--
-- That was harmless only while the two companies held disjoint code sets. It
-- stopped being harmless when 0297_acc_autocount_chart.sql gave company 1 "the
-- same 31-account template company 2 carries": every code then existed twice, so
-- each journal line matched two account rows and fanned out. `.eq('company_id')`
-- on the route cannot filter it — v_gl_entries selects j.company_id, which is
-- identical on both fan-out rows; v_account_balances groups by a.company_id, so
-- company 1's bucket sums company 2's lines and vice versa.
--
-- The fix is the join predicate the composite key always implied.
--
-- CREATE OR REPLACE, never DROP + CREATE: 0189 -> 0190 -> 0191 is the recorded
-- precedent where dropping a view lost its grants and the API 403'd until they
-- were re-issued. REPLACE preserves ownership and privileges. The column list,
-- order and types are unchanged, which is what REPLACE requires and also what
-- keeps every consumer working untouched.

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
     -- BOTH halves of the accounts key (0188). The bare-code join fanned every
     -- line out across both companies' copies of the same code.
     JOIN scm.accounts a ON a.account_code = l.account_code
                        AND a.company_id   = j.company_id
  WHERE j.posted = true
  ORDER BY j.entry_date DESC, j.je_no DESC, l.line_no;

COMMENT ON VIEW scm.v_gl_entries IS
  'Flat posted-GL stream. Includes REVERSED originals alongside their contra entries (mig 0290) - they net to zero and an auditor needs both; the `reversed` / `reversed_by_je` columns identify the pair. Excludes unposted drafts only. Joins accounts on (account_code, company_id) - the bare-code join double-counted every line once both companies held the same chart (mig 0303).';

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
     -- The company predicate rides on the JOURNAL, not the line: journal_entry_
     -- lines has no company_id of its own. Putting it in the ON clause (not
     -- WHERE) keeps this a LEFT join, so an account with no posted lines still
     -- reports a zero balance rather than vanishing from the chart.
     LEFT JOIN scm.journal_entries j ON j.posted = true AND j.reversed = false
                                    AND j.company_id = a.company_id
     LEFT JOIN scm.journal_entry_lines l ON l.journal_entry_id = j.id
                                        AND l.account_code = a.account_code
  GROUP BY a.account_code, a.account_name, a.account_type, a.company_id
  ORDER BY a.account_code;

COMMENT ON VIEW scm.v_account_balances IS
  'Per-account balances, one row per (company, account). Sums only journal lines whose ENTRY belongs to the same company as the account (mig 0303) - before that the bare-code join summed both companies into each bucket. LEFT joins so a chart account with no activity still reports zero.';
