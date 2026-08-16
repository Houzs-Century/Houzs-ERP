-- REVERSAL: everything here is additive. DROP TABLE scm.acc_acquirers;
-- DELETE FROM scm.acc_account_roles WHERE role IN
--   ('CASH','BANK_DEFAULT','TRANSIT_EDC','TRANSIT_ONLINE','CUSTOMER_DEPOSITS');
-- No existing row is modified.
--
-- acc_customer_payments — phase 2A: the accounts customer money moves through,
-- and the acquirer master (brief §2.13: the name the screen shows and the code
-- reconciliation matches must be ONE row, not a string coincidence).
-- NOTE: number re-checked against the tree at merge time.
--
-- Context, verified in production 2026-08-16: 2,703 SO payment rows carrying
-- RM 9.34M exist and none has ever reached the ledger (the exact 系统3 hole
-- the brief opens with). The five acquirers in live use are CIMB / GHL / HLB /
-- MBB / PBB — seeded below with display_name equal to the exact strings the
-- sales payment panel stores in merchant_provider, so the translation between
-- screen and ledger is a JOIN, not a guess. Statement formats / fee methods /
-- unique-ref flags stay NULL until the owner fills 决定4; reconciliation
-- (phase 2B) refuses to auto-confirm an acquirer whose config is incomplete.

-- 1. The payment-side account roles, every company.
INSERT INTO scm.acc_account_roles (company_id, role, account_code) VALUES
  (1, 'CASH',              '335-0000'),
  (1, 'BANK_DEFAULT',      '330-0000'),
  (1, 'TRANSIT_EDC',       '320-0000'),
  (1, 'TRANSIT_ONLINE',    '325-0000'),
  (1, 'CUSTOMER_DEPOSITS', '410-0000'),
  (2, 'CASH',              '335-0000'),
  (2, 'BANK_DEFAULT',      '330-0000'),
  (2, 'TRANSIT_EDC',       '320-0000'),
  (2, 'TRANSIT_ONLINE',    '325-0000'),
  (2, 'CUSTOMER_DEPOSITS', '410-0000')
ON CONFLICT (company_id, role) DO NOTHING;

-- 2. The acquirer master. display_name is what the sales screen stores in
--    merchant_provider; code is what the module reasons with. One row, both.
CREATE TABLE scm.acc_acquirers (
  company_id           INTEGER NOT NULL,
  code                 TEXT    NOT NULL,
  display_name         TEXT    NOT NULL,
  transit_account_code TEXT    NOT NULL DEFAULT '320-0000',
  fee_account_code     TEXT    NOT NULL DEFAULT '930-0000',
  bank_account_code    TEXT,
  -- 决定4 columns: filled per acquirer before phase 2B reconciliation goes live.
  statement_format     TEXT,             -- CSV / PDF / XLSX
  has_unique_ref       BOOLEAN,          -- NULL = unknown; FALSE forces manual confirm
  fee_method           TEXT,             -- stated / gross-minus-net / prorated-summary
  date_tolerance_days  INTEGER NOT NULL DEFAULT 3,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, code)
);
CREATE UNIQUE INDEX acc_acquirers_display ON scm.acc_acquirers (company_id, display_name);

INSERT INTO scm.acc_acquirers (company_id, code, display_name) VALUES
  (1, 'CIMB', 'CIMB'),
  (1, 'GHL',  'GHL'),
  (1, 'HLB',  'HLB'),
  (1, 'MBB',  'MBB'),
  (1, 'PBB',  'PBB'),
  (2, 'CIMB', 'CIMB'),
  (2, 'GHL',  'GHL'),
  (2, 'HLB',  'HLB'),
  (2, 'MBB',  'MBB'),
  (2, 'PBB',  'PBB');
