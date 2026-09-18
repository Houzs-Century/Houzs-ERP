-- 20260913T1700_acc_settlement_link_so_2607_012_amount.sql
-- REVERSAL: UPDATE scm.acc_settlement_matches SET amount_sen = 305300 WHERE company_id = 2 AND payment_source = 'SOPAY' AND payment_id::text = '311a0b9b-1603-48a0-b8e1-883a04da4bb3' AND doc_no = '2990-SO-2607-012' AND amount_sen = 305200;
--   One data row, no DDL. GRANTS: none to re-apply.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   ONE merchant-reconciliation link (docs/bugs/0859). SO-2607-012's payment
--   was corrected by Finance on 2026-09-11 from RM 3,053.00 to RM 3,052.00
--   (docs/bugs/0821); its link to PBB's 2026-07-12 line (ref 005805) was
--   written at upload with the old amount and confirmed the same day, before
--   #3723 (docs/bugs/0833) taught the report to refresh an UNCONFIRMED link
--   from its payment — a confirmed link is deliberately never rewritten by
--   code. The fee and the posting are right (they come off the report's own
--   line); only the link's amount, shown on the Merchant reconciliation
--   screen, is stale by RM 1.00. Owner 2026-09-13: 可以.
--   Guarded on the payment id, the document number and the stale value, so
--   it is a no-op anywhere the row already reads right. Company 2 only.
--
-- Reversal / Verified against: in the PR body, where the check reads them.

SET search_path = scm, public;

UPDATE scm.acc_settlement_matches
   SET amount_sen = 305200
 WHERE company_id = 2
   AND payment_source = 'SOPAY'
   AND payment_id::text = '311a0b9b-1603-48a0-b8e1-883a04da4bb3'
   AND doc_no = '2990-SO-2607-012'
   AND amount_sen = 305300;
