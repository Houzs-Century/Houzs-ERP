-- 0348: the AP split's one piece of history (owner 2026-09-03, deciding with
-- the blast radius on the table: 这个先帮我检查先我再决定 → checked → 做).
--
-- From this release, a 405-x supplier's paper books to AP_OTHER (405-0000,
-- OTHER CREDITOS) instead of AP (400-0000) — apControlRole in acc/rules.ts,
-- one home, used by the PI posting rule, the AP-payment guard and the
-- self-check's third arm. Code handles the future; THIS file moves the past,
-- and the past is exactly one journal: company 2's PI 2990-PI-2608-018
-- (RM 16,440.00, 405-Z002 ZHEJIANG JU MIAO), the only 405-supplier bill that
-- ever posted a journal. Its sibling 2990-PI-2607-004 (405-N001) posted
-- before the GL foundation existed and carries no journal at all; both
-- HOUZS-side 405 suppliers have zero documents. Verified on the live
-- database 2026-09-03: the 405-supplier census returned pis=1+1, pvs=0,
-- advances=0, and a source_doc_no join found journals only for -018.
--
-- The UPDATE is scoped by company + source journal + old code, so a replay
-- (or a tree where the journal never existed) is a clean no-op. The
-- composite FK journal_entry_lines_company_account_fk checks the NEW value:
-- (2,'405-0000') has existed in scm.accounts since the chart seed
-- (2026-09-03, VERIFIED on a fresh connection).
--
-- Verified against: the staging rehearsal applies this before any prod
-- deploy runs it; the census queries above ran on the live database.
-- Reversal: UPDATE scm.journal_entry_lines l SET account_code = '400-0000'
--   FROM scm.journal_entries je WHERE je.id = l.journal_entry_id
--   AND je.company_id = 2 AND je.source_type = 'PI'
--   AND je.source_doc_no = '2990-PI-2608-018' AND l.account_code = '405-0000';

UPDATE scm.journal_entry_lines l
SET account_code = '405-0000'
FROM scm.journal_entries je
WHERE je.id = l.journal_entry_id
  AND je.company_id = 2
  AND je.source_type = 'PI'
  AND je.source_doc_no = '2990-PI-2608-018'
  AND l.company_id = 2
  AND l.account_code = '400-0000';
