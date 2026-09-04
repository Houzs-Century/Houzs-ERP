-- 0350: Other Debtors — the counterparty registry and its two documents
-- (owner 2026-09-03, the design he confirmed line by line: other debtor 主要
-- 就是我会开 bill 其他和生意性质没有关系的人或公司收回钱; bills post
-- directly, 收款单 walks the same four layers as the PV and knocks bills off
-- like an AP Payment, partial included).
--
-- The GL never carries per-party sub-accounts (照理 chart of account 只能维护
-- 其他的): 305-0000 OTHER DEBTOR stays the ONE control (role AR_OTHER), and
-- per-party truth lives here — a bill raises the receivable (Dr 305-0000 /
-- Cr the bill lines' own accounts, source ODB), a receipt collects it
-- (Dr bank / Cr 305-0000, source ODR) and bumps received_sen on the bills it
-- ticks, exactly the pv-settle shape.
--
-- Everything is additive and idempotent. No FKs onto scm.accounts on
-- purpose — the account columns follow the chart like every acc_* sibling.
--
-- Verified against: backend/tests/otherDebtors.test.ts (the route contract
-- on the fake harness) and the staging rehearsal, which applies this before
-- any prod deploy runs it.
-- Reversal: DROP TABLE scm.acc_debtor_receipt_allocations;
--   DROP TABLE scm.acc_debtor_receipts; DROP TABLE scm.acc_debtor_bill_lines;
--   DROP TABLE scm.acc_debtor_bills; DROP TABLE scm.acc_debtors;

CREATE TABLE IF NOT EXISTS scm.acc_debtors (
  id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id  bigint      NOT NULL,
  name        text        NOT NULL,
  phone       text,
  notes       text,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text
);
CREATE INDEX IF NOT EXISTS idx_acc_debtors_company ON scm.acc_debtors (company_id);

CREATE TABLE IF NOT EXISTS scm.acc_debtor_bills (
  id           uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id   bigint      NOT NULL,
  bill_number  text        NOT NULL,
  debtor_id    uuid        NOT NULL REFERENCES scm.acc_debtors(id),
  bill_date    date        NOT NULL,
  total_sen    bigint      NOT NULL,
  received_sen bigint      NOT NULL DEFAULT 0,
  status       text        NOT NULL DEFAULT 'POSTED', -- POSTED | PAID | CANCELLED
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  UNIQUE (company_id, bill_number)
);
CREATE INDEX IF NOT EXISTS idx_acc_debtor_bills_debtor ON scm.acc_debtor_bills (debtor_id);

CREATE TABLE IF NOT EXISTS scm.acc_debtor_bill_lines (
  id                  uuid   NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id          bigint NOT NULL,
  bill_id             uuid   NOT NULL REFERENCES scm.acc_debtor_bills(id) ON DELETE CASCADE,
  line_no             int    NOT NULL,
  description         text,
  credit_account_code text   NOT NULL,
  amount_sen          bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acc_debtor_bill_lines_bill ON scm.acc_debtor_bill_lines (bill_id);

CREATE TABLE IF NOT EXISTS scm.acc_debtor_receipts (
  id                uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id        bigint      NOT NULL,
  receipt_number    text        NOT NULL,
  debtor_id         uuid        NOT NULL REFERENCES scm.acc_debtors(id),
  receipt_date      date        NOT NULL,
  bank_account_code text        NOT NULL,
  total_sen         bigint      NOT NULL,
  status            text        NOT NULL DEFAULT 'DRAFT', -- DRAFT | POSTED | CANCELLED
  -- The owner's four layers, PV-shaped (0343): markers, not statuses.
  submitted_at timestamptz, submitted_by text,
  checked_at   timestamptz, checked_by   text,
  approved_at  timestamptz, approved_by  text,
  posted_at    timestamptz,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  UNIQUE (company_id, receipt_number)
);
CREATE INDEX IF NOT EXISTS idx_acc_debtor_receipts_debtor ON scm.acc_debtor_receipts (debtor_id);

CREATE TABLE IF NOT EXISTS scm.acc_debtor_receipt_allocations (
  id         uuid   NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id bigint NOT NULL,
  receipt_id uuid   NOT NULL REFERENCES scm.acc_debtor_receipts(id) ON DELETE CASCADE,
  bill_id    uuid   NOT NULL REFERENCES scm.acc_debtor_bills(id),
  amount_sen bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acc_debtor_receipt_allocations_receipt
  ON scm.acc_debtor_receipt_allocations (receipt_id);
