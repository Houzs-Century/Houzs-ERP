-- 20260930T0600_acc_payment_requests.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.acc_payment_request_files; DROP TABLE IF EXISTS scm.acc_payment_requests;
--   Revert the code first (routes/payment-requests.ts and the voucher link in
--   createPaymentVoucherCore read and write these tables). The vouchers made from
--   requests stay — only the request trail and its index of files go; the bytes
--   under payment-request-files/<company>/<request>/ in the SLIPS R2 bucket are not
--   SQL's to remove (list with `wrangler r2 object list`, delete by key, or leave
--   them orphaned — nothing reads a key without its index row).
--   GRANTS: none to re-apply — like scm.acc_pv_files (0352) and
--   scm.acc_ap_invoice_files, both tables ride the scm schema's default privileges
--   (service_role); this file grants nothing, so the reverse re-grants nothing.
-- Verified against: staging (minnapsemfzjmtvnnvdd) via MCP apply_migration on
--   2026-09-30; both tables, the checks and the indexes read back in the PR body.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: two new empty
-- tables and their indexes; no existing row is written or altered.
--
-- WHY (owner 2026-09-29/30 — 3a, 4a: Event 的 rental 要还的要相关负责人 upload，然后我
-- finance 这里负责做 payment，慢慢接下来全部 payment 都会需要). A PAYMENT REQUEST is
-- the requester's half: who to pay, how much, by when, for which event, what for,
-- the payee's bank details, and the bill itself (files). Finance answers it with a
-- payment voucher (pv_id) through the untouched voucher cycle; the requester reads
-- 已付 when that voucher is approved and 银行已确认 once the bank line is matched —
-- both read off the voucher, never copied here, so the request cannot disagree
-- with the money. Stored status is only what the voucher cannot say:
--   SUBMITTED  waiting for Finance
--   VOUCHERED  Finance made voucher pv_id for it (a cancelled voucher lets Finance
--              make the next one)
--   REJECTED   Finance returned it — finance_note says why
--   WITHDRAWN  the requester took it back before Finance acted
-- request_no is {co}PRQ-YYMM-NNN (lib/doc-no.ts mintMonthlyDocNo).

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS scm.acc_payment_requests (
  id                uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id        bigint      NOT NULL,
  request_no        text        NOT NULL,
  requested_by      bigint      NOT NULL,
  requested_by_name text,
  payee_name        text        NOT NULL,
  amount_sen        bigint      NOT NULL CHECK (amount_sen > 0),
  due_date          date,
  purpose           text        NOT NULL,
  project_id        bigint,
  bank_name         text,
  bank_account_no   text,
  bank_account_name text,
  status            text        NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED', 'VOUCHERED', 'REJECTED', 'WITHDRAWN')),
  pv_id             uuid        REFERENCES scm.payment_vouchers(id) ON DELETE SET NULL,
  finance_note      text,
  decided_by        text,
  decided_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS acc_payment_requests_company_no ON scm.acc_payment_requests (company_id, request_no);
CREATE INDEX IF NOT EXISTS idx_acc_payment_requests_requester ON scm.acc_payment_requests (company_id, requested_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_acc_payment_requests_status ON scm.acc_payment_requests (company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_acc_payment_requests_pv ON scm.acc_payment_requests (pv_id) WHERE pv_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS scm.acc_payment_request_files (
  id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id  bigint      NOT NULL,
  request_id  uuid        NOT NULL REFERENCES scm.acc_payment_requests(id) ON DELETE CASCADE,
  file_key    text        NOT NULL UNIQUE,
  file_name   text        NOT NULL,
  mime        text        NOT NULL,
  size_bytes  bigint      NOT NULL,
  sort_no     int         NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text
);
CREATE INDEX IF NOT EXISTS idx_acc_payment_request_files_request ON scm.acc_payment_request_files (request_id);
