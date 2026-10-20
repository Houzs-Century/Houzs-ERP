-- 20261020T0250_acc_je_contras_post.sql
-- REVERSAL: revert the engine change (acc/engine.ts reverseJournal) first, then
--   (2) un-post what step 2 posted:
--       UPDATE scm.journal_entries SET posted = false
--        WHERE je_no IN (<the je_nos listed under WHAT THIS CHANGES>) AND posted = true;
--   (1) put the old index back:
--       DROP INDEX IF EXISTS scm.acc_je_one_active_source;
--       CREATE UNIQUE INDEX acc_je_one_active_source ON scm.journal_entries
--         (COALESCE(company_id, 1), source_type, source_doc_no)
--         WHERE posted AND COALESCE(reversed, FALSE) = FALSE AND source_doc_no IS NOT NULL;
--   The old index can only come back while no document holds two POSTED
--   contras — i.e. after the un-post above, and before any further edit.
--   GRANTS: none touched — one index and data rows.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   1. The unique index acc_je_one_active_source ("one ACTIVE entry per source
--      document", 0296) stops covering CONTRA entries (source_type ending
--      _REVERSAL). It still allows only one live posting of each document —
--      SI, PI, API, ODB, SOPAY, STOCKADJ … — exactly as before. A document
--      voided twice legitimately carries two contras, one per void; the old
--      index refused the second one's `posted = true`.
--   2. Posts the contras that refusal left unposted: an entry of a _REVERSAL
--      type, posted = false, voiding (reversed_by_je) an original that is
--      posted, flagged reversed and points back at it, with the same total.
--      The balance trigger (trg_je_balanced) checks each one balances as it
--      posts. On 2026-10-20 (read-only scan, check-unposted-contras.mjs) that
--      was 35 entries:
--        company 1: JE-2610-0023, JE-2610-0500, JE-2610-0547 (API);
--          JE-2609-0319, JE-2609-0962 (ODB); JE-2610-0334 (PI);
--          JE-2609-0209, JE-2609-0688, JE-2610-0642 (SOPAY);
--          JE-2608-0048, JE-2609-0343, JE-2607-0010, JE-2608-0050, JE-2608-0058,
--          JE-2609-0838, JE-2609-1066, JE-2610-0242, JE-2609-1075, JE-2610-0322,
--          JE-2609-1085, JE-2610-0420 (STOCKADJ);
--        company 2: 2990-JE-2603-0005, 2990-JE-2610-0220, 2990-JE-2609-0404 (API);
--          2990-JE-2609-0330 (PI); 2990-JE-2606-0140, 2990-JE-2606-0148,
--          2990-JE-2608-0243, 2990-JE-2608-0248, 2990-JE-2609-0313,
--          2990-JE-2609-0318 (SOPAY); 2990-JE-2607-0205, 2990-JE-2608-0355,
--          2990-JE-2608-0363, 2990-JE-2609-0350 (STOCKADJ).
--      NO STATEMENT FIGURE MOVES. The statements, GL, TB, Journal tabs, bank
--      reconciliation and the PMS event books count an entry only when it is
--      posted AND on neither side of a reversal pair (acc/reversal-pairs.ts
--      countsInTheBooks); each of these originals is already flagged reversed,
--      so the pair is excluded before and after. What changes is the raw sum of
--      posted lines, which today counts the voided original with no contra
--      against it (HC-ODB-2609-002 sums to RM 138,400 for a RM 69,200 bill).
-- Verified against: staging via staging-migrate.yml on this branch (see the PR).
--
-- WHY (owner 2026-10-20, 「这样要修」). reverseJournal wrote the contra unposted,
-- then set posted = true without reading the answer. For a document's SECOND
-- void (edited twice, edited then cancelled, a month's stock entry re-closed
-- twice) the index refused that update, the original was flagged reversed
-- anyway, and the caller booked the document afresh over a void that never
-- posted. The engine now reads both answers (same PR); this file removes the
-- refusal and finishes the voids it interrupted.

SET search_path = scm, public;

DROP INDEX IF EXISTS scm.acc_je_one_active_source;
CREATE UNIQUE INDEX acc_je_one_active_source
  ON scm.journal_entries (COALESCE(company_id, 1), source_type, source_doc_no)
  WHERE posted AND COALESCE(reversed, FALSE) = FALSE AND source_doc_no IS NOT NULL
    AND source_type NOT LIKE '%\_REVERSAL';

UPDATE scm.journal_entries c
   SET posted = true
  FROM scm.journal_entries o
 WHERE c.posted = false
   AND c.source_type LIKE '%\_REVERSAL'
   AND c.reversed_by_je = o.id
   AND o.reversed_by_je = c.id
   AND o.posted = true
   AND o.reversed = true
   AND o.company_id = c.company_id
   AND o.total_debit_sen = c.total_debit_sen;
