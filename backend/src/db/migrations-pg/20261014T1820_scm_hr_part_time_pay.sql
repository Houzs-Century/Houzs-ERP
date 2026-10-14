-- 20261014T1820_scm_hr_part_time_pay.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.hr_part_time_pay;
--   ALTER TABLE scm.acc_payment_requests DROP COLUMN IF EXISTS part_time_pay_id;
--   Revert the code first (routes/hr-part-time-pay.ts writes the table and the
--   requests that carry the column). GRANTS: the one GRANT below goes with the
--   table.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new
-- empty table and its indexes, plus one nullable column on acc_payment_requests
-- with no default and no backfill; no existing row is rewritten.
--
-- WHY (owner 2026-10-14): a part-time salesperson at an event is paid one
-- amount — 2% of sales, RM 120 a day, and the WiFi allowance for one person —
-- through the same payment request Finance already answers. The owner keys the
-- sheet (one row per part-timer per event, with the bank details), HR confirms
-- it, and the confirm raises the payment request; Finance pays one voucher per
-- person and attaches the bank slip to it. The sheet keeps the figures the
-- request was raised from, so what HR confirmed never moves under it:
--   DRAFT      keyed by the owner, HR has not confirmed
--   CONFIRMED  HR confirmed — request_id is the payment request raised for it
-- One WiFi allowance per event is a partial unique index, not a rule in code.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS scm.hr_part_time_pay (
  id                uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id        bigint      NOT NULL,
  project_id        bigint      NOT NULL,
  staff_id          uuid        NOT NULL REFERENCES scm.staff(id),
  staff_name        text        NOT NULL,
  days              integer     NOT NULL CHECK (days >= 0),
  sales_sen         bigint      NOT NULL DEFAULT 0,
  commission_bps    integer     NOT NULL,
  commission_sen    bigint      NOT NULL,
  day_rate_sen      bigint      NOT NULL,
  salary_sen        bigint      NOT NULL,
  wifi_sen          bigint      NOT NULL DEFAULT 0,
  total_sen         bigint      NOT NULL,
  bank_name         text,
  bank_account_no   text,
  bank_account_name text,
  note              text,
  status            text        NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'CONFIRMED')),
  request_id        uuid        REFERENCES scm.acc_payment_requests(id) ON DELETE SET NULL,
  requested_by      bigint      NOT NULL,
  requested_by_name text,
  confirmed_by      text,
  confirmed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hr_part_time_pay_event_staff ON scm.hr_part_time_pay (company_id, project_id, staff_id);
CREATE UNIQUE INDEX IF NOT EXISTS hr_part_time_pay_one_wifi ON scm.hr_part_time_pay (company_id, project_id) WHERE wifi_sen > 0;
CREATE INDEX IF NOT EXISTS idx_hr_part_time_pay_request ON scm.hr_part_time_pay (request_id) WHERE request_id IS NOT NULL;

ALTER TABLE scm.acc_payment_requests ADD COLUMN IF NOT EXISTS part_time_pay_id uuid;
CREATE INDEX IF NOT EXISTS idx_acc_payment_requests_part_time ON scm.acc_payment_requests (part_time_pay_id) WHERE part_time_pay_id IS NOT NULL;

-- Same as 0061: RLS on, no policies — anon/authenticated see nothing; the Worker's
-- service_role bypasses RLS.
ALTER TABLE scm.hr_part_time_pay ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE scm.hr_part_time_pay TO service_role;

NOTIFY pgrst, 'reload schema';
