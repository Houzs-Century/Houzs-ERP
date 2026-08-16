-- REVERSAL: everything here is additive. DROP INDEX scm.acc_je_one_active_source;
-- ALTER TABLE scm.journal_entries DROP CONSTRAINT acc_je_balanced_totals;
-- ALTER TABLE scm.journal_entry_lines DROP CONSTRAINT acc_jel_nonneg, DROP CONSTRAINT acc_jel_one_sided;
-- DROP TABLE scm.acc_account_roles;
-- DELETE FROM scm.accounts WHERE company_id = 2 AND account_code IN ('1100','1200','2000','4000');
--
-- acc_gl_foundation — phase 0 of the accounting module (docs/新ERP会计模块需求书.md).
-- NOTE: number re-checked against the tree at merge time (repo rule: duplicate
-- numbers break pg-migrate; gaps are fine).
--
-- What this adds, and why each is a DATABASE rule rather than app code:
--   1. Balanced-totals CHECK on journal_entries — the app engine validates
--      before writing, this repeats the law where no code path can skip it
--      (brief §3.4: debit=credit checked at two layers).
--   2. Line sanity CHECKs — sen amounts are non-negative and every line is
--      one-sided (Dr xor Cr).
--   3. acc_je_one_active_source — at most ONE active (posted, not reversed)
--      journal entry per (company, source_type, source_doc_no). The engine's
--      idempotency read fails closed, and whatever a read blip lets through
--      dies here as a 23505 instead of double-booking revenue (brief §2.1's
--      "one gate", enforced by the database itself).
--   4. scm.acc_account_roles — which account plays which ROLE (AR / SALES /
--      INVENTORY / AP) per company. Posting code resolves roles, never
--      hardcodes codes; phase 1's AutoCount-style renumbering edits THIS
--      table + the chart, not the engine.
--   5. Company 2 chart backfill — its journal lines already reference the
--      bare codes 1100/1200/2000/4000 (hardcoded before roles existed) but
--      its chart never contained them. Add them so history, validation and
--      the roles seeds agree; phase 1 renumbers properly.

-- 1. Balanced totals, always.
ALTER TABLE scm.journal_entries
  ADD CONSTRAINT acc_je_balanced_totals CHECK (total_debit_sen = total_credit_sen);

-- 2. Line sanity.
ALTER TABLE scm.journal_entry_lines
  ADD CONSTRAINT acc_jel_nonneg CHECK (debit_sen >= 0 AND credit_sen >= 0);
ALTER TABLE scm.journal_entry_lines
  ADD CONSTRAINT acc_jel_one_sided CHECK (NOT (debit_sen > 0 AND credit_sen > 0));

-- 3. One ACTIVE entry per source document, per company.
CREATE UNIQUE INDEX acc_je_one_active_source
  ON scm.journal_entries (COALESCE(company_id, 1), source_type, source_doc_no)
  WHERE posted AND COALESCE(reversed, FALSE) = FALSE AND source_doc_no IS NOT NULL;

-- 4. Account roles master.
CREATE TABLE scm.acc_account_roles (
  company_id   INTEGER NOT NULL,
  role         TEXT    NOT NULL,
  account_code TEXT    NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, role)
);

INSERT INTO scm.acc_account_roles (company_id, role, account_code) VALUES
  (1, 'AR',        '1100'),
  (1, 'SALES',     '4000'),
  (1, 'INVENTORY', '1200'),
  (1, 'AP',        '2000'),
  (2, 'AR',        '1100'),
  (2, 'SALES',     '4000'),
  (2, 'INVENTORY', '1200'),
  (2, 'AP',        '2000')
ON CONFLICT (company_id, role) DO NOTHING;

-- 5. Company 2 chart backfill: the codes its ledger lines already use.
INSERT INTO scm.accounts (account_code, account_name, account_type, parent_code, is_active, company_id)
SELECT v.code, v.name, v.type, NULL, TRUE, 2
FROM (VALUES
  ('1100', 'Accounts Receivable', 'ASSET'),
  ('1200', 'Inventory',           'ASSET'),
  ('2000', 'Accounts Payable',    'LIABILITY'),
  ('4000', 'Sales Revenue',       'INCOME')
) AS v(code, name, type)
WHERE NOT EXISTS (
  SELECT 1 FROM scm.accounts a WHERE a.company_id = 2 AND a.account_code = v.code
);
