-- REVERSAL: every UPDATE is a keyed, invertible mapping and nothing is deleted.
-- Run the section-2 VALUES map inverted on scm.journal_entry_lines (new_code ->
-- old_code), repoint scm.acc_account_roles back to 1100/1200/2000/4000, then
-- UPDATE scm.accounts SET is_active = TRUE for the legacy codes and DELETE the
-- 31 template rows inserted for company_id = 1 in section 1.
--
-- acc_autocount_chart — phase 1: ONE AutoCount-style chart for every company.
-- (Owner decision 2026-08-16: unify on the XXX-XXXX numbering the accountant
-- already knows; company 2's freshly-rebuilt 31-account chart is the template.)
-- NOTE: number re-checked against the tree at merge time.
--
-- Why now: the ledger holds 7 journal entries / 14 lines, all on the four
-- legacy bare codes — renumbering today is a 14-row UPDATE; renumbering after
-- phase 2 would be a swamp. Payment vouchers: zero rows reference any account
-- code yet (verified in production 2026-08-16).
--
-- Old accounts are DEACTIVATED, never deleted — the row itself is the alias
-- record (brief §2.9: renames keep their history).

-- 1. Give company 1 (HOUZS) the same 31-account template company 2 carries.
--    Parent rows (900-0000) must exist before children; single INSERT is fine
--    because parent_code is not a foreign key — the hierarchy is resolved by
--    code at read time.
INSERT INTO scm.accounts (account_code, account_name, account_type, parent_code, is_active, company_id)
SELECT v.code, v.name, v.type, v.parent, TRUE, 1
FROM (VALUES
  ('100-0000', 'Capital',                             'EQUITY',    NULL),
  ('105-0000', 'Retained Earnings',                   'EQUITY',    NULL),
  ('110-0000', 'Current Profit',                      'EQUITY',    NULL),
  ('200-0000', 'Fixed Assets (net of depreciation)',  'ASSET',     NULL),
  ('300-0000', 'Trade Debtor',                        'ASSET',     NULL),
  ('305-0000', 'Other Debtor',                        'ASSET',     NULL),
  ('310-0000', 'Inventory',                           'ASSET',     NULL),
  ('315-0000', 'Prepayments',                         'ASSET',     NULL),
  ('320-0000', 'Card Machine Clearing (EDC)',         'ASSET',     NULL),
  ('325-0000', 'Online Payment Clearing (FPX/e-wallet)', 'ASSET',  NULL),
  ('330-0000', 'Bank — Maybank Current',              'ASSET',     NULL),
  ('331-0000', 'Bank — Hong Leong Current',           'ASSET',     NULL),
  ('335-0000', 'Cash on Hand',                        'ASSET',     NULL),
  ('400-0000', 'Trade Creditor',                      'LIABILITY', NULL),
  ('405-0000', 'Other Creditor',                      'LIABILITY', NULL),
  ('410-0000', 'Customer Deposits',                   'LIABILITY', NULL),
  ('415-0000', 'SST Payable',                         'LIABILITY', NULL),
  ('420-0000', 'Long-term Loans',                     'LIABILITY', NULL),
  ('500-0000', 'Sales Revenue',                       'INCOME',    NULL),
  ('600-0000', 'Cost of Goods Sold',                  'EXPENSE',   NULL),
  ('700-0000', 'Other Income',                        'INCOME',    NULL),
  ('900-0000', 'Operating Expense',                   'EXPENSE',   NULL),
  ('905-0000', 'Rent',                                'EXPENSE',   '900-0000'),
  ('910-0000', 'Utilities',                           'EXPENSE',   '900-0000'),
  ('915-0000', 'Salaries & Wages',                    'EXPENSE',   '900-0000'),
  ('920-0000', 'Depreciation',                        'EXPENSE',   '900-0000'),
  ('925-0000', 'Delivery & Logistics Expense',        'EXPENSE',   '900-0000'),
  ('930-0000', 'Merchant/Gateway Charges',            'EXPENSE',   '900-0000'),
  ('935-0000', 'Forex Gain/Loss',                     'EXPENSE',   '900-0000'),
  ('940-0000', 'Other Operating Expense',             'EXPENSE',   '900-0000'),
  ('945-0000', 'Discount Given',                      'EXPENSE',   NULL)
) AS v(code, name, type, parent)
WHERE NOT EXISTS (
  SELECT 1 FROM scm.accounts a WHERE a.company_id = 1 AND a.account_code = v.code
);

-- 2. The legacy → AutoCount code map, applied to every ledger line. Covers the
--    bare codes (company 1 + the four 0296 backfilled into company 2) and the
--    2990-prefixed mirrors. 5100 maps to 940-0000 (not the 900-0000 parent):
--    a parent header takes no postings, and any stray line must stay postable.
UPDATE scm.journal_entry_lines l
SET account_code = m.new_code
FROM (VALUES
  ('1000', '335-0000'), ('2990-1000', '335-0000'),
  ('1010', '330-0000'), ('2990-1010', '330-0000'),
  ('1100', '300-0000'), ('2990-1100', '300-0000'),
  ('1200', '310-0000'), ('2990-1200', '310-0000'),
  ('2000', '400-0000'), ('2990-2000', '400-0000'),
  ('2100', '415-0000'), ('2990-2100', '415-0000'),
  ('3000', '100-0000'), ('2990-3000', '100-0000'),
  ('4000', '500-0000'), ('2990-4000', '500-0000'),
  ('4100', '700-0000'), ('2990-4100', '700-0000'),
  ('5000', '600-0000'), ('2990-5000', '600-0000'),
  ('5100', '940-0000'), ('2990-5100', '940-0000'),
  ('5200', '945-0000'), ('2990-5200', '945-0000')
) AS m(old_code, new_code)
WHERE l.account_code = m.old_code;

-- 3. Roles now point at the AutoCount chart, for every company that has roles.
UPDATE scm.acc_account_roles SET account_code = '300-0000', updated_at = now() WHERE role = 'AR';
UPDATE scm.acc_account_roles SET account_code = '310-0000', updated_at = now() WHERE role = 'INVENTORY';
UPDATE scm.acc_account_roles SET account_code = '400-0000', updated_at = now() WHERE role = 'AP';
UPDATE scm.acc_account_roles SET account_code = '500-0000', updated_at = now() WHERE role = 'SALES';

-- 4. Retire the legacy codes: deactivated, kept as the alias record. Matches
--    bare 3-4 digit codes and the 2990- mirrors; never touches XXX-XXXX.
UPDATE scm.accounts
SET is_active = FALSE
WHERE (account_code ~ '^[0-9]{4}$' OR account_code ~ '^2990-[0-9]{4}$');
