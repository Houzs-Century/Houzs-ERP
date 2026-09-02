-- REVERSAL:
--   ALTER TABLE ... ALTER CONSTRAINT ... NOT DEFERRABLE;  -- each of the five
--   below, same guards. Deferrability is the ONLY thing this file touches:
--   the constraints keep enforcing exactly the same rule, checked at commit
--   instead of per-statement.
--
-- defer_account_fks — the rescue that lets 0344_acc land on production.
--
-- WHY THIS FILE SHARES NUMBER 0344 (KNOWN_DUPLICATES has the entry):
-- 0344_acc_autocount_code_migration is APPLIED on staging but PENDING on
-- production, where it fails:
--   update or delete on table "accounts" violates foreign key constraint
--   "payment_vouchers_company_credit_account_fk"
-- (run 33643498372). Production has voucher rows referencing the codes the
-- relay renames; the FK checks per-statement, so the hop's first UPDATE
-- (accounts) breaks the reference one statement before the voucher UPDATE
-- would mend it. Staging has no such rows, which is why it passed there —
-- and why editing 0344_acc is off the table: its checksum is already in
-- staging's tracker. The ONLY file position that runs before a pending
-- 0344_acc on production is a name that sorts before it — pg-migrate orders
-- by full filename, and "0344_aaa" < "0344_acc". The number is a label to
-- the runner, never an identity (migrationNumbers.test's own words).
--
-- WHAT IT DOES: marks every FK that points at scm.accounts as DEFERRABLE
-- INITIALLY DEFERRED. Each migration runs in one transaction, so when
-- 0344_acc replays on production its FK checks now happen at COMMIT — after
-- the relay has moved BOTH sides of every reference — and pass. The rule
-- itself is never weakened: a genuinely dangling reference still refuses,
-- at commit. On staging this file applies the same ALTERs (harmless; the
-- relay is already done there).

-- 0188's per-company FKs — the one that fired, and its two siblings.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_vouchers_company_credit_account_fk') THEN
    ALTER TABLE scm.payment_vouchers
      ALTER CONSTRAINT payment_vouchers_company_credit_account_fk DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_voucher_lines_company_debit_account_fk') THEN
    ALTER TABLE scm.payment_voucher_lines
      ALTER CONSTRAINT payment_voucher_lines_company_debit_account_fk DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_entry_lines_company_account_fk') THEN
    ALTER TABLE scm.journal_entry_lines
      ALTER CONSTRAINT journal_entry_lines_company_account_fk DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- 0081's single-column FKs (pre-multi-company). They may or may not survive
-- in any given environment; where they do, they point at accounts too.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_vouchers_credit_account_fk') THEN
    ALTER TABLE scm.payment_vouchers
      ALTER CONSTRAINT payment_vouchers_credit_account_fk DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_voucher_lines_debit_account_fk') THEN
    ALTER TABLE scm.payment_voucher_lines
      ALTER CONSTRAINT payment_voucher_lines_debit_account_fk DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
