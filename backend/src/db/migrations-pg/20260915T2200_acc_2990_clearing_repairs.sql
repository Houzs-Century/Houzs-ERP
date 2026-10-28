-- 20260915T2200_acc_2990_clearing_repairs.sql
-- REVERSAL: DELETE FROM scm.journal_entry_lines l USING scm.journal_entries j WHERE l.journal_entry_id = j.id AND j.company_id = 2 AND j.source_doc_no IN ('SETTLEMOVE-67', 'REPAIR-THECONTS-1499'); DELETE FROM scm.journal_entries WHERE company_id = 2 AND source_doc_no IN ('SETTLEMOVE-67', 'REPAIR-THECONTS-1499');
--   Both entries are repairs this file wrote and nothing else references
--   (no document row, no settlement stamp, no receipt); deleting them puts
--   the three accounts back exactly as they were. Their JE numbers are then
--   gaps in the 2608 series, which is the price of a reversal, not a fault.
--   GRANTS: none touched — data rows only.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   TWO posted journal entries for company 2 (2990), four lines, RM 4,739.00
--   moved between three accounts. No table, view or grant changes. Company 1
--   (HOUZS) is not touched. Idempotent: each entry is keyed on its
--   source_doc_no and is written only when no live entry carries it.
--
-- WHY (owner 2026-09-15, from the balance sheet as at 31/08/2026: card machine
-- clearing 看起来不太对 … 这个要做). Two things were sitting in the wrong
-- clearing account, and the owner asked for both to be put right by journal:
--
--   1. SO-2608-013, RM 3,240.00 — keyed at the till as PBB, so its payment
--      entry debited 326-0010 CARD MACHINE CLEARING — PBB; the money actually
--      came through the HLB terminal and was matched on HLB's statement
--      (settlement row 67, 2026-08-10 ref 822776), whose payout was cleared
--      out of 326-0040 CARD MACHINE CLEARING — HLB. The confirm never moved
--      the money between the two — until docs/bugs/0940 it only moved money
--      keyed WITHOUT a bank off the generic account — so PBB read RM 3,240 too
--      high and HLB the same too low. This is the SETTLEMOVE the fixed confirm
--      would have written: keyed SETTLEMOVE-67 like every other move, so an
--      un-confirm of that line reverses it the same way, dated the settlement
--      day.
--
--   2. THE CONTS SDN BHD, RM 1,499.00 — a loan to the related party
--      (350-0010) was repaid by card at the HLB terminal. The payout landed in
--      HLBB on 2026-08-26 and was booked Dr bank / Cr 326-0040 like any payout,
--      but no sale sits behind it, so nothing ever debited the clearing
--      account: HLB clearing read RM 1,499 short and the loan still read as
--      owed. The owner's own entry (2026-09-15: journal Dr 326-0040 / Cr
--      350-0010 RM 1,499 dated 24/08): the day the card was swiped.
--
-- After both, as at 31/08/2026: 326-0010 PBB = RM 20,103.00 (six payments not
-- yet matched), 326-0040 HLB = RM 1,355.00 (SO-2608-057, not yet matched),
-- 350-0010 = 0.
--
-- NUMBERING: each entry takes the next number of the 2990-JE-2608 series, the
-- way the application mints for a backdated entry (the month of the entry's
-- own date, docs/bugs/0522). The series was at 2990-JE-2608-0329 when this was
-- written (prod, read-only, 2026-09-15); the expression below reads the live
-- maximum, so a number minted in between is not reused.
--
-- posted is set directly (the balance trigger fires on UPDATE, when posted
-- flips; the totals here are stated and the lines below balance them).

SET search_path = scm, public;

-- 1. SO-2608-013: PBB → HLB clearing, dated the settlement day, keyed to row 67.
WITH next_no AS (
  SELECT '2990-JE-2608-' || lpad((coalesce(max(substring(je_no from '(\d+)$')::int), 0) + 1)::text, 4, '0') AS je_no
  FROM scm.journal_entries
  WHERE company_id = 2 AND je_no LIKE '2990-JE-2608-%'
),
ins AS (
  INSERT INTO scm.journal_entries (company_id, je_no, entry_date, source_type, source_doc_no, narration, total_debit_sen, total_credit_sen, posted, posted_at, reversed)
  SELECT 2, next_no.je_no, DATE '2026-08-10', 'SETTLEMOVE', 'SETTLEMOVE-67',
         'HLB settlement 2026-08-10 ref 822776 — 2990-SO-2608-013 keyed on 326-0010: moved from 326-0010 to 326-0040 (repair, docs/bugs/0940)',
         324000, 324000, true, now(), false
  FROM next_no
  WHERE NOT EXISTS (
    SELECT 1 FROM scm.journal_entries j WHERE j.company_id = 2 AND j.source_doc_no = 'SETTLEMOVE-67' AND j.reversed = false
  )
  RETURNING id
)
INSERT INTO scm.journal_entry_lines (company_id, journal_entry_id, line_no, account_code, debit_sen, credit_sen, notes)
SELECT 2, ins.id, 1, '326-0040', 324000, 0, 'Named by the merchant''s statement — HLB settlement 2026-08-10 ref 822776' FROM ins
UNION ALL
SELECT 2, ins.id, 2, '326-0010', 0, 324000, 'Out of clearing 326-0010 — HLB settlement 2026-08-10 ref 822776' FROM ins;

-- 2. THE CONTS: the loan repaid by card, dated the day of the swipe.
WITH next_no AS (
  SELECT '2990-JE-2608-' || lpad((coalesce(max(substring(je_no from '(\d+)$')::int), 0) + 1)::text, 4, '0') AS je_no
  FROM scm.journal_entries
  WHERE company_id = 2 AND je_no LIKE '2990-JE-2608-%'
),
ins AS (
  INSERT INTO scm.journal_entries (company_id, je_no, entry_date, source_type, source_doc_no, narration, total_debit_sen, total_credit_sen, posted, posted_at, reversed)
  SELECT 2, next_no.je_no, DATE '2026-08-24', 'MANUAL', 'REPAIR-THECONTS-1499',
         'THE CONTS SDN BHD — loan repaid by card at the HLB terminal, payout received 26/08/2026',
         149900, 149900, true, now(), false
  FROM next_no
  WHERE NOT EXISTS (
    SELECT 1 FROM scm.journal_entries j WHERE j.company_id = 2 AND j.source_doc_no = 'REPAIR-THECONTS-1499' AND j.reversed = false
  )
  RETURNING id
)
INSERT INTO scm.journal_entry_lines (company_id, journal_entry_id, line_no, account_code, debit_sen, credit_sen, party_type, party_code, party_name, notes)
SELECT 2, ins.id, 1, '326-0040', 149900, 0, NULL, NULL, NULL, 'Loan repaid by card at the HLB terminal — payout received 26/08/2026' FROM ins
UNION ALL
SELECT 2, ins.id, 2, '350-0010', 0, 149900, NULL, NULL, 'THE CONTS SDN BHD', 'Loan to THE CONTS SDN BHD repaid' FROM ins;
