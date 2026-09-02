-- REVERSAL: run the relay in REVERSE order with each pair swapped
--   (310-0010→330-0000 first, then 330-0000→310-0000, … finishing with
--   326-0000→320-0000), the same seven UPDATE targets each time; restore the
--   five renamed rows' old names; DELETE the inserted 310-0000 parent rows;
--   SET DEFAULT back to '320-0000' on the two transit columns; flip
--   acc_money back (330-0000 true, 310-0010/310-0020/320-0000 as they were).
--   Every step is a keyed, invertible mapping — nothing is deleted except
--   the parent rows this file inserted.
--
-- acc_autocount_code_migration — the owner's chart, the owner's codes
-- (2026-09-02: 迁到 AutoCount 码 — so ERP↔AutoCount reconciliation reads the
-- same code as the same account, no translation table in anyone's head).
--
-- The ERP's 31-account template (0297) and the AutoCount chart use the SAME
-- codes for DIFFERENT things (ERP 330-0000 = Maybank bank; AutoCount
-- 330-0000 = STOCK). This file moves the ERP onto AutoCount's meanings for
-- the ten rows where the codes collide or the accountant's chart says the
-- account lives elsewhere, renames five rows whose codes already agree, and
-- leaves every other template row untouched — the maintenance screen
-- (next PR) is where those get merged or retired by a person, not by a
-- migration guessing.
--
-- THE RELAY ORDER IS THE CORRECTNESS: 320 must vacate (→326) before 335
-- moves in, 330 must vacate (→310-0010) before 310's Inventory moves in
-- (→330 STOCK), and only then is 310-0000 free to become the CASH AT BANK
-- parent. Each hop updates EVERY place a code lives:
--   scm.accounts (the row itself), scm.journal_entry_lines,
--   scm.payment_vouchers.credit_account_code,
--   scm.payment_voucher_lines.debit_account_code,
--   scm.acc_vendor_memory.debit_account_code,
--   scm.acc_company_acquirers (transit/fee/bank; acc_acquirers is its VIEW),
--   scm.acc_bank_configs.account_code (the owner's MBB/PBB statement
--   configs hang here), scm.acc_bank_statements.account_code (his uploaded
--   statements), scm.acc_account_roles.
-- The mapping is identical for every company, so the updates are global.
--
-- 326/327 are ERP-extension codes (card-machine / online clearing — the
-- settlement layer's own accounts; AutoCount has no equivalent) parked in a
-- gap AutoCount leaves free (322-325 are its wallets, 328+ unused).

-- ── The relay, one hop at a time ────────────────────────────────────────────
DO $$
DECLARE
  hop RECORD;
BEGIN
  FOR hop IN
    SELECT * FROM (VALUES
      ('320-0000', '326-0000', 'CARD MACHINE CLEARING (EDC)',            NULL),
      ('325-0000', '327-0000', 'ONLINE PAYMENT CLEARING (FPX/E-WALLET)', NULL),
      ('330-0000', '310-0010', 'CASH AT BANK - MAYBANK',                 '310-0000'),
      ('331-0000', '310-0020', 'CASH AT BANK - HLBB',                    '310-0000'),
      ('335-0000', '320-0000', 'CASH IN HAND',                          NULL),
      ('310-0000', '330-0000', 'STOCK',                                 NULL),
      ('410-0000', '400-0001', 'DEPOSIT',                               '400-0000'),
      ('105-0000', '150-0000', 'RETAINED EARNING',                      NULL),
      ('315-0000', '360-0000', 'PREPAYMENT & ADVANCE',                  NULL),
      ('420-0000', '460-0000', 'LOAN/BORROWING',                        NULL)
    ) AS m(old_code, new_code, new_name, new_parent)
  LOOP
    UPDATE scm.accounts
       SET account_code = hop.new_code, account_name = hop.new_name,
           parent_code = hop.new_parent
     WHERE account_code = hop.old_code;
    UPDATE scm.journal_entry_lines      SET account_code         = hop.new_code WHERE account_code         = hop.old_code;
    UPDATE scm.payment_vouchers         SET credit_account_code  = hop.new_code WHERE credit_account_code  = hop.old_code;
    UPDATE scm.payment_voucher_lines    SET debit_account_code   = hop.new_code WHERE debit_account_code   = hop.old_code;
    UPDATE scm.acc_vendor_memory        SET debit_account_code   = hop.new_code WHERE debit_account_code   = hop.old_code;
    /* acc_acquirers is a VIEW over this table since 0332 — updating the
       table updates the view; touching the view itself would refuse. */
    UPDATE scm.acc_company_acquirers    SET transit_account_code = hop.new_code WHERE transit_account_code = hop.old_code;
    UPDATE scm.acc_company_acquirers    SET fee_account_code     = hop.new_code WHERE fee_account_code     = hop.old_code;
    UPDATE scm.acc_company_acquirers    SET bank_account_code    = hop.new_code WHERE bank_account_code    = hop.old_code;
    UPDATE scm.acc_bank_configs         SET account_code         = hop.new_code WHERE account_code         = hop.old_code;
    UPDATE scm.acc_bank_statements      SET account_code         = hop.new_code WHERE account_code         = hop.old_code;
    UPDATE scm.acc_account_roles        SET account_code         = hop.new_code WHERE account_code         = hop.old_code;
  END LOOP;
END $$;

-- ── The vacated 310-0000 becomes the CASH AT BANK parent (per company) ─────
-- A parent aggregates and is NOT posted to (owner: 父户不记账,只选叶子) —
-- acc_money stays false so it never appears in Paid From.
INSERT INTO scm.accounts (account_code, account_name, account_type, parent_code, is_active, company_id)
SELECT '310-0000', 'CASH AT BANK', 'ASSET', NULL, TRUE, c.company_id
FROM (SELECT DISTINCT company_id FROM scm.accounts) c
WHERE NOT EXISTS (
  SELECT 1 FROM scm.accounts a
  WHERE a.company_id = c.company_id AND a.account_code = '310-0000'
);

-- ── Same-code renames onto the accountant's exact wording ──────────────────
UPDATE scm.accounts SET account_name = 'CAPITAL'             WHERE account_code = '100-0000';
UPDATE scm.accounts SET account_name = 'ACCOUNT RECEIVEABLE' WHERE account_code = '300-0000';
UPDATE scm.accounts SET account_name = 'OTHER DEBTOR'        WHERE account_code = '305-0000';
UPDATE scm.accounts SET account_name = 'ACCOUNT PAYABLE'     WHERE account_code = '400-0000';
UPDATE scm.accounts SET account_name = 'OTHER CREDITOS'      WHERE account_code = '405-0000';

-- ── Money flags follow the MEANING, not the code ───────────────────────────
-- 330-0000 is STOCK now: it must never offer itself as Paid From again.
UPDATE scm.accounts SET acc_money = TRUE
 WHERE account_code IN ('310-0010', '310-0020', '320-0000');
UPDATE scm.accounts SET acc_money = FALSE
 WHERE account_code = '330-0000';

-- ── New rows born after today default to the new transit code ──────────────
ALTER TABLE scm.acc_company_acquirers
  ALTER COLUMN transit_account_code SET DEFAULT '326-0000';
