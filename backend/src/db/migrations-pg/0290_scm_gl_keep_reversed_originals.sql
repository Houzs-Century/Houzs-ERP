-- 0290_scm_gl_keep_reversed_originals.sql
--
-- REVERSAL: CREATE OR REPLACE VIEW scm.v_gl_entries AS <the previous definition,
--           preserved verbatim in the migration that last created it>. A view
--           holds no data, so nothing is lost either way.
--
-- THE GENERAL LEDGER WAS HIDING HALF OF EVERY REVERSAL.
--
-- Cancelling a Sales Invoice does two things (lib/post-si-revenue.ts:238-283,
-- and the same shape for PI at routes/accounting.ts:531 and PV at
-- routes/payment-vouchers.ts:1028): it POSTS a full contra journal entry, and it
-- flags the original `reversed = true, reversed_by_je = <contra>`. That is the
-- correct data model — an auditor needs both entries.
--
-- scm.v_gl_entries then threw one of them away. Its predicate
--
--     WHERE j.posted = true AND j.reversed = false
--
-- sat in the WHERE of an INNER-join chain, so the flagged ORIGINAL vanished and
-- only the contra survived. An RM10,000 invoice, cancelled, read as revenue
-- −10,000 and AR −10,000 in the GL tab and in the `GET /accounting/gl` export,
-- with no trace that it was ever booked.
--
-- Its sibling scm.v_account_balances carries the identical predicate in a
-- LEFT JOIN ... ON instead, so the lines survive there and the two entries sum
-- to zero. Two endpoints over the same ledger therefore disagreed by 2x. And
-- this is not a rare path: resyncSiRevenue (post-si-revenue.ts:361) does
-- reverse-and-repost on EVERY post-issue line edit, not only on cancellation.
--
-- Owner decision 2026-08-13, asked directly: keep the original in the GL, show
-- both entries, let them net.
--
-- WHAT CHANGES
--   · `AND j.reversed = false` is dropped from the WHERE. `j.posted = true`
--     stays — an unposted draft has booked nothing and must not appear.
--   · `j.reversed` and `j.reversed_by_je` are EXPOSED as columns so a reader can
--     mark the pair instead of inferring it. The one consumer
--     (routes/accounting.ts:645) does `select('*')`, so added columns pass
--     straight through and no client needs to change.
--   · The two new columns are APPENDED, AFTER company_id. That position is not
--     cosmetic, and this file learned it the expensive way.
--
-- THIS MIGRATION FAILED IN PRODUCTION ONCE, and that is recorded here rather
-- than quietly corrected, because the mistake is invisible in review and only a
-- real PostgreSQL rejects it:
--
--     FAILED 0290_scm_gl_keep_reversed_originals.sql:
--     cannot change name of view column "line_id" to "journal_entry_id"
--
-- pg-migrate runs inside the deploy BEFORE wrangler, so the backend deploy
-- stopped and every later migration queued behind this one until it was fixed.
--
-- The first version was written against an OLD definition of the view. It
-- opened `j.id AS journal_entry_id` where the LIVE view (mig 0106) opens
-- `l.id AS line_id`, and it placed the two new columns BEFORE company_id.
-- CREATE OR REPLACE VIEW permits neither: existing column names, types and
-- ORDER must match exactly, and new columns may only be appended. This
-- paragraph used to end "ordering, company_id and every existing column are
-- untouched" — a claim about a database, asserted without one.
--
-- The tempting repair is DROP VIEW + CREATE VIEW, and it is the wrong one: a
-- recreated view is a NEW object with an EMPTY ACL, which is how mig 0189 took
-- the production Sales Order list down for every user and needed both 0190 and
-- 0191 to put the grants back. Matching the live column list keeps this a
-- REPLACE, so no privilege is ever dropped.
--
-- Regression test: backend/tests-pg/glViewKeepsReversed.pg.test.ts. It builds
-- mig 0106's view as its FIXTURE and applies this file on top — the only
-- arrangement that can catch the class, since a test that built the view from
-- this file's own SQL would pass while production failed.
--
-- WHAT DOES NOT CHANGE, deliberately
--   v_account_balances is left exactly as it is. Its LEFT JOIN places the
--   posted/reversed test on `j` while summing `l.debit_sen`, so lines whose
--   journal entry is unposted or reversed still contribute — which means its
--   totals include DRAFT entries, and the zero it reports for a cancelled
--   invoice is arrived at by a different route than the one this migration
--   fixes. That is a separate question with a different answer (it changes
--   reported balances), so it is recorded in docs/audit-2026-08-13-ledger.md for
--   the owner rather than changed in the same breath.
--
-- REVERSIBLE: this is CREATE OR REPLACE VIEW over a view whose full prior text
-- is in 0106_report_views_company_id.sql. Re-running 0106's block restores it.

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
    -- APPENDED, and the position is load-bearing (see the header): these name
    -- the reversal pair instead of hiding one side of it.
    j.reversed,
    j.reversed_by_je
   FROM scm.journal_entry_lines l
     JOIN scm.journal_entries j ON j.id = l.journal_entry_id
     JOIN scm.accounts a ON a.account_code = l.account_code
  WHERE j.posted = true
  ORDER BY j.entry_date DESC, j.je_no DESC, l.line_no;

COMMENT ON VIEW scm.v_gl_entries IS
  'Flat posted-GL stream. Includes REVERSED originals alongside their contra entries (mig 0290) - they net to zero and an auditor needs both; the `reversed` / `reversed_by_je` columns identify the pair. Excludes unposted drafts only.';
