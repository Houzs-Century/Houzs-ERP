-- 20260910T0147_acc_merchant_fee_account_to_terminal_charges.sql
--
-- REVERSAL: point the links back and restore the old default —
--   UPDATE scm.acc_company_acquirers SET fee_account_code = '930-0000'
--    WHERE fee_account_code = '900-T009';
--   ALTER TABLE scm.acc_company_acquirers
--     ALTER COLUMN fee_account_code SET DEFAULT '930-0000';
--   That returns the exact state this migration found, including the broken
--   one: 930-0000 is DEACTIVATED in both companies, so reversing puts the
--   refusal back. It is written out because a reversal that cannot be
--   performed is not a reversal, not because anyone should want it.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--
-- CONFIG ONLY. Two rows of scm.acc_company_acquirers per company, plus a column
-- default. No journal, no balance, no document is touched, and nothing that has
-- already posted moves — this decides which expense account the NEXT merchant
-- fee is booked to.
--
-- WHY. Owner, 2026-09-09, confirming a PBB settlement line:
--
--     Line 18: account 930-0000 is deactivated
--
-- 930-0000 is "MISCELLANEOUS EXPENSES XXX", a placeholder in the AutoCount
-- chart, and it is INACTIVE in both companies. It was the fee account every
-- acquirer link was seeded with in migration 0332, back when the chart was the
-- old one. The AutoCount relay (0346) and the owner's 397-account seed
-- (2026-09-03) replaced the chart underneath, and this default was never
-- repointed — so every merchant statement in both companies has been unable to
-- book its fee since, and the failure only surfaces at the moment somebody
-- confirms a line.
--
-- WHICH ACCOUNT: the owner's own choice, 2026-09-09, asked between BANK CHARGES,
-- PROCESSING FEES, COMMISSION and TERMINAL charges — 900-T009. (He first typed
-- 900-T010 and corrected himself: that one is TRAVELLING EXPENSES - OTHER.)
--
-- GUARDED THREE WAYS, because a config change that lands on the wrong account
-- is invisible until a P&L is read:
--   • only rows still pointing at the deactivated placeholder are moved;
--   • the target must exist, be an EXPENSE, be ACTIVE and be a LEAF in that
--     same company — the posting gate refuses a header account, so pointing at
--     one would swap this refusal for another;
--   • the whole thing refuses loudly if any company would be left behind.

SET search_path = public, scm;

DO $$
DECLARE
  target CONSTANT text := '900-T009';
  moved  int;
  bad    int;
BEGIN
  /* The target must be postable in EVERY company that has a link to move.
     Checked before anything is written, and by the same three properties the
     posting gate checks. */
  SELECT count(*) INTO bad
  FROM (SELECT DISTINCT company_id FROM scm.acc_company_acquirers
         WHERE fee_account_code = '930-0000') l
  WHERE NOT EXISTS (
    SELECT 1 FROM scm.accounts a
     WHERE a.company_id = l.company_id
       AND a.account_code = target
       AND a.account_type = 'EXPENSE'
       AND a.is_active
       AND NOT EXISTS (SELECT 1 FROM scm.accounts k
                        WHERE k.company_id = a.company_id AND k.parent_code = a.account_code));

  IF bad > 0 THEN
    RAISE EXCEPTION
      '% is not a postable expense leaf in % company/companies that need it — nothing changed',
      target, bad;
  END IF;

  UPDATE scm.acc_company_acquirers
     SET fee_account_code = target, updated_at = now()
   WHERE fee_account_code = '930-0000';
  GET DIAGNOSTICS moved = ROW_COUNT;
  RAISE NOTICE 'merchant fee account -> %: % link(s) moved', target, moved;
END $$;

-- And the DEFAULT, so a company set up tomorrow does not inherit the same dead
-- placeholder. The route's own fallback moves with it (accounting-settlement).
ALTER TABLE scm.acc_company_acquirers
  ALTER COLUMN fee_account_code SET DEFAULT '900-T009';

COMMENT ON COLUMN scm.acc_company_acquirers.fee_account_code IS
  'Where this company books THIS acquirer''s merchant fee. Owner''s choice '
  '2026-09-09: 900-T009 TERMINAL INTEREST CHARGES. Was 930-0000, a placeholder '
  'the AutoCount chart deactivated, which refused every settlement confirm.';
