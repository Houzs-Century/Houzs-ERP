-- REVERSAL: run the relay VALUES in REVERSE order with each pair swapped
--   (310-0010→330-0000 first … 326-0000→320-0000 last) inside the same
--   defer/restore sandwich; restore the five renamed rows' old names; DELETE
--   the inserted 310-0000 parent rows; SET DEFAULT back to '320-0000'; flip
--   acc_money back (330-0000 true; 310-0010/310-0020/320-0000 false). Every
--   step is a keyed, invertible mapping — nothing is deleted except the
--   parent rows this file inserted.
--
-- acc_autocount_code_relay — the REDO of reverted 0344 (#2889), built to
-- docs/bugs/0615's bar: option 1 of its three ways out, PROVED against a
-- real Postgres by tests-pg/accAutocountCodeRelay.pg.test.ts, which builds
-- the parent/child fixture WITH 0188's three composite FKs, replays this
-- file by suffix, and asserts the codes moved in accounts AND in the
-- children — plus that a second replay is a no-op (the staging story).
--
-- What 0344 taught, twice (0614, 0615): the relay renames a NATURAL KEY
-- that non-deferrable FKs point at, so the parent UPDATE is refused per
-- statement one step before the child UPDATE would mend it — and staging
-- green proved only the empty-table path, because staging held no voucher
-- rows. Production's two draft vouchers are exactly what fired it.
--
-- THE SANDWICH: the FKs are made DEFERRABLE, this transaction defers them,
-- the relay moves BOTH sides of every reference, and the constraints are
-- restored to NOT DEFERRABLE at the end — which re-checks them right here,
-- so a mistake in the relay refuses THIS migration instead of surviving it.
-- The rule never weakens for anyone else: outside this transaction the FKs
-- behave exactly as before.
--
-- STAGING IDEMPOTENCE: staging already carries the new codes (reverted
-- 0344_acc applied there before the revert; its tracker row is orphaned by
-- the revert and retired). Every relay UPDATE matches zero rows there, the
-- parent INSERT is WHERE NOT EXISTS, the renames and flag flips are
-- already-true, and the FK ALTERs are round trips — this file lands on
-- staging as a no-op and on production as the move.
--
-- The relay itself is 0344's corrected body (acc_bank_statement_config, the
-- 0614 fix) unchanged: ten hops in dependency order — 320 vacates to 326
-- before 335 moves in; 330 vacates to 310-0010 before Inventory takes 330;
-- only then is 310-0000 free to become the CASH AT BANK parent. 326/327 are
-- ERP-extension clearing codes in AutoCount's free gap.

-- ── 1. Make the accounts-pointing FKs deferrable (five, each guarded) ──────
DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('scm.payment_vouchers',      'payment_vouchers_company_credit_account_fk'),
      ('scm.payment_voucher_lines', 'payment_voucher_lines_company_debit_account_fk'),
      ('scm.journal_entry_lines',   'journal_entry_lines_company_account_fk'),
      ('scm.payment_vouchers',      'payment_vouchers_credit_account_fk'),
      ('scm.payment_voucher_lines', 'payment_voucher_lines_debit_account_fk')
    ) AS v(tbl, con)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = fk.con) THEN
      EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE', fk.tbl, fk.con);
      EXECUTE format('SET CONSTRAINTS %s.%I DEFERRED', 'scm', fk.con);
    END IF;
  END LOOP;
END $$;

-- ── 2. The relay, one hop at a time ────────────────────────────────────────
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
    /* IDEMPOTENCE GUARD, proved necessary by the evidence test's second
       replay: on a tree that already migrated (staging), hop 330→310-0010
       would otherwise match the NEW 330-0000 (STOCK, placed by a later hop)
       and collide with the existing 310-0010. A hop whose new code already
       exists has already happened — skip it whole, children included (they
       already carry the new code too). Within one fresh run the relay order
       guarantees the new code never pre-exists. */
    IF EXISTS (SELECT 1 FROM scm.accounts WHERE account_code = hop.new_code) THEN
      CONTINUE;
    END IF;
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
    /* acc_bank_statement_config is 0336's real name — the 0614 lesson. */
    UPDATE scm.acc_bank_statement_config SET account_code        = hop.new_code WHERE account_code         = hop.old_code;
    UPDATE scm.acc_bank_statements      SET account_code         = hop.new_code WHERE account_code         = hop.old_code;
    UPDATE scm.acc_account_roles        SET account_code         = hop.new_code WHERE account_code         = hop.old_code;
  END LOOP;
END $$;

-- ── 3. The vacated 310-0000 becomes the CASH AT BANK parent (per company) ──
-- A parent aggregates and is NOT posted to (owner: 父户不记账,只选叶子) —
-- acc_money stays false so it never appears in Paid From.
INSERT INTO scm.accounts (account_code, account_name, account_type, parent_code, is_active, company_id)
SELECT '310-0000', 'CASH AT BANK', 'ASSET', NULL, TRUE, c.company_id
FROM (SELECT DISTINCT company_id FROM scm.accounts) c
WHERE NOT EXISTS (
  SELECT 1 FROM scm.accounts a
  WHERE a.company_id = c.company_id AND a.account_code = '310-0000'
);

-- ── 4. Same-code renames onto the accountant's exact wording ───────────────
UPDATE scm.accounts SET account_name = 'CAPITAL'             WHERE account_code = '100-0000';
UPDATE scm.accounts SET account_name = 'ACCOUNT RECEIVEABLE' WHERE account_code = '300-0000';
UPDATE scm.accounts SET account_name = 'OTHER DEBTOR'        WHERE account_code = '305-0000';
UPDATE scm.accounts SET account_name = 'ACCOUNT PAYABLE'     WHERE account_code = '400-0000';
UPDATE scm.accounts SET account_name = 'OTHER CREDITOS'      WHERE account_code = '405-0000';

-- ── 5. Money flags follow the MEANING, not the code ────────────────────────
-- 330-0000 is STOCK now: it must never offer itself as Paid From again.
UPDATE scm.accounts SET acc_money = TRUE
 WHERE account_code IN ('310-0010', '310-0020', '320-0000');
UPDATE scm.accounts SET acc_money = FALSE
 WHERE account_code = '330-0000';

-- ── 6. New rows born after today default to the new transit code ───────────
ALTER TABLE scm.acc_company_acquirers
  ALTER COLUMN transit_account_code SET DEFAULT '326-0000';

-- ── 7. Restore the FKs to NOT DEFERRABLE — which RE-CHECKS them here ───────
-- A relay that left any reference dangling refuses THIS migration, now,
-- instead of surviving into anyone's books.
DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('scm.payment_vouchers',      'payment_vouchers_company_credit_account_fk'),
      ('scm.payment_voucher_lines', 'payment_voucher_lines_company_debit_account_fk'),
      ('scm.journal_entry_lines',   'journal_entry_lines_company_account_fk'),
      ('scm.payment_vouchers',      'payment_vouchers_credit_account_fk'),
      ('scm.payment_voucher_lines', 'payment_voucher_lines_debit_account_fk')
    ) AS v(tbl, con)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = fk.con) THEN
      EXECUTE format('SET CONSTRAINTS %s.%I IMMEDIATE', 'scm', fk.con);
      EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I NOT DEFERRABLE', fk.tbl, fk.con);
    END IF;
  END LOOP;
END $$;
