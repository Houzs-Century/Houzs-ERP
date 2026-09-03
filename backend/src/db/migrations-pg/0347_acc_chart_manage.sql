-- 0347: the chart grows management arms (the owner's 2026-09-03 review of the
-- seeded tree, six numbered points).
--
-- 1) accounts.special_type — the AutoCount "special account" column his export
--    carries in column 9 (SBK bank / SCH cash / SDC debtor control / SCC
--    creditor control / SFA fixed asset / SAD accumulated depreciation / SRE
--    retained earning / SBS balance-sheet stock / SDP deferred / SOS opening
--    stock / SCS closing stock / SOP wallet-like payment). Stored verbatim so
--    the control-account lock (SDC/SCC/SBS refuse manual picks) and future
--    fixed-asset / stock-close features key off the file's own vocabulary.
--    Backfilled here for every company that carries the code, so the flag is
--    live the moment this applies — no seed re-run required (the seed carries
--    the same values for future imports and companies).
--
-- 2) scm.acc_rename_account(old, new) — 改码全账跟, his words: "我要如何改
--    account code 和 名字,然后一改，整个ledger 都要能改". One transaction
--    renames a code EVERYWHERE: the accounts rows of every company carrying
--    it, the parent_code of its children, and the nine reference homes 0346
--    relayed (journal_entry_lines, payment_vouchers.credit,
--    payment_voucher_lines.debit, acc_vendor_memory.debit,
--    acc_company_acquirers transit/fee/bank, acc_bank_statement_config,
--    acc_bank_statements, acc_account_roles). Insert-move-delete order, on
--    purpose: the three 0188 composite FKs (NOT VALID + ON DELETE RESTRICT —
--    they DO check newly-written child rows and DO restrict parent deletes)
--    are satisfied at every step, because the new accounts rows exist before
--    any reference moves and every reference has moved before the old rows
--    die. A collision with an existing code dies on
--    accounts_company_account_code_unique and rolls the whole transaction
--    back — renaming onto a live code would silently merge two books, so it
--    is refused, never merged.
--
-- Verified against: backend/tests-pg/accChartRename.pg.test.ts (CI
-- backend-postgres job) — production-shaped fixture with the 0188 FKs
-- verbatim, this file applied by suffix, rename proven to move every home,
-- collision and unknown-code refusals proven to raise.
-- Reversal: DROP FUNCTION scm.acc_rename_account(text, text);
--           ALTER TABLE scm.accounts DROP COLUMN IF EXISTS special_type;

ALTER TABLE scm.accounts ADD COLUMN IF NOT EXISTS special_type text;

-- The 56 special rows of the accountant's export (Chart of Accounts, Include
-- Desc 2), keyed by code so every company that carries the code gets the flag.
UPDATE scm.accounts a SET special_type = v.sp FROM (VALUES
  ('150-0000','SRE'),
  ('201-1000','SFA'),
  ('201-1005','SAD'),
  ('201-2000','SFA'),
  ('201-2005','SAD'),
  ('202-1000','SFA'),
  ('202-1005','SAD'),
  ('202-2000','SFA'),
  ('202-2005','SAD'),
  ('202-3000','SFA'),
  ('202-3005','SAD'),
  ('203-1000','SFA'),
  ('203-1005','SAD'),
  ('203-2000','SFA'),
  ('203-2005','SAD'),
  ('204-1000','SFA'),
  ('204-1005','SAD'),
  ('204-2000','SFA'),
  ('204-2005','SAD'),
  ('204-3000','SFA'),
  ('204-3005','SAD'),
  ('205-1000','SFA'),
  ('205-1005','SAD'),
  ('205-2000','SFA'),
  ('205-2005','SAD'),
  ('205-3000','SFA'),
  ('205-3005','SAD'),
  ('205-4000','SFA'),
  ('205-4005','SAD'),
  ('200-8000','SFA'),
  ('200-8005','SAD'),
  ('207-1000','SFA'),
  ('207-1005','SAD'),
  ('300-0000','SDC'),
  ('305-0000','SDC'),
  ('310-0010','SBK'),
  ('310-0020','SBK'),
  ('310-0030','SBK'),
  ('310-0040','SBK'),
  ('310-0050','SBK'),
  ('310-0060','SBK'),
  ('310-0090','SBK'),
  ('310-0100','SBK'),
  ('320-0000','SCH'),
  ('321-0000','SCH'),
  ('322-0000','SOP'),
  ('323-0000','SOP'),
  ('324-0000','SOP'),
  ('325-0000','SCH'),
  ('330-0000','SBS'),
  ('399-9999','SDP'),
  ('400-0000','SCC'),
  ('400-0001','SCC'),
  ('405-0000','SCC'),
  ('600-0000','SOS'),
  ('620-0000','SCS')
) AS v(code, sp)
WHERE a.account_code = v.code AND a.special_type IS DISTINCT FROM v.sp;

CREATE OR REPLACE FUNCTION scm.acc_rename_account(p_old text, p_new text)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  n_accounts int; n_children int; n_jel int; n_pvc int; n_pvl int;
  n_vendor int; n_acq int; n_acq2 int; n_acq3 int;
  n_bankcfg int; n_stmts int; n_roles int;
BEGIN
  IF p_old IS NULL OR p_new IS NULL OR p_old = p_new THEN
    RAISE EXCEPTION 'rename needs two different codes';
  END IF;
  IF p_new !~ '^\d{3}-[A-Za-z0-9]{4}$' THEN
    RAISE EXCEPTION 'new code % is not in the NNN-XXXX account-code shape', p_new;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM scm.accounts WHERE account_code = p_old) THEN
    RAISE EXCEPTION 'account % does not exist in any company', p_old;
  END IF;
  IF EXISTS (SELECT 1 FROM scm.accounts WHERE account_code = p_new) THEN
    RAISE EXCEPTION 'account % already exists — renaming onto a live code would merge two books; refused', p_new;
  END IF;

  -- New rows first, so the composite FKs have somewhere to point the moment
  -- references start moving. created_at rides along: the account is the same
  -- account, only its number changed.
  INSERT INTO scm.accounts
    (company_id, account_code, account_name, account_type, parent_code,
     is_active, acc_money, special_type, created_at)
  SELECT company_id, p_new, account_name, account_type, parent_code,
         is_active, acc_money, special_type, created_at
  FROM scm.accounts WHERE account_code = p_old;
  GET DIAGNOSTICS n_accounts = ROW_COUNT;

  UPDATE scm.accounts SET parent_code = p_new WHERE parent_code = p_old;
  GET DIAGNOSTICS n_children = ROW_COUNT;

  UPDATE scm.journal_entry_lines SET account_code = p_new WHERE account_code = p_old;
  GET DIAGNOSTICS n_jel = ROW_COUNT;
  UPDATE scm.payment_vouchers SET credit_account_code = p_new WHERE credit_account_code = p_old;
  GET DIAGNOSTICS n_pvc = ROW_COUNT;
  UPDATE scm.payment_voucher_lines SET debit_account_code = p_new WHERE debit_account_code = p_old;
  GET DIAGNOSTICS n_pvl = ROW_COUNT;
  UPDATE scm.acc_vendor_memory SET debit_account_code = p_new WHERE debit_account_code = p_old;
  GET DIAGNOSTICS n_vendor = ROW_COUNT;
  UPDATE scm.acc_company_acquirers SET transit_account_code = p_new WHERE transit_account_code = p_old;
  GET DIAGNOSTICS n_acq = ROW_COUNT;
  UPDATE scm.acc_company_acquirers SET fee_account_code = p_new WHERE fee_account_code = p_old;
  GET DIAGNOSTICS n_acq2 = ROW_COUNT;
  UPDATE scm.acc_company_acquirers SET bank_account_code = p_new WHERE bank_account_code = p_old;
  GET DIAGNOSTICS n_acq3 = ROW_COUNT;
  UPDATE scm.acc_bank_statement_config SET account_code = p_new WHERE account_code = p_old;
  GET DIAGNOSTICS n_bankcfg = ROW_COUNT;
  UPDATE scm.acc_bank_statements SET account_code = p_new WHERE account_code = p_old;
  GET DIAGNOSTICS n_stmts = ROW_COUNT;
  UPDATE scm.acc_account_roles SET account_code = p_new WHERE account_code = p_old;
  GET DIAGNOSTICS n_roles = ROW_COUNT;

  -- Every reference has moved; RESTRICT has nothing left to protect.
  DELETE FROM scm.accounts WHERE account_code = p_old;

  RETURN jsonb_build_object(
    'accounts', n_accounts, 'children', n_children,
    'journal_lines', n_jel, 'pv_credit', n_pvc, 'pv_debit', n_pvl,
    'vendor_memory', n_vendor, 'acquirers', n_acq + n_acq2 + n_acq3,
    'bank_config', n_bankcfg, 'bank_statements', n_stmts, 'roles', n_roles);
END;
$fn$;
