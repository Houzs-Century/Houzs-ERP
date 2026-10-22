-- 20260930T1500_scm_so_payment_backdate_requests.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.so_payment_backdate_requests;
--   Revert the code first (routes/so-payment-backdate-requests.ts reads and writes
--   it). Payments already booked from an approved request stay — they are ordinary
--   scm.mfg_sales_order_payments rows; only the request trail goes.
--   GRANTS: none to re-apply — the table rides the scm schema's default privileges
--   (service_role), like scm.document_cancel_requests.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new empty
-- table and its indexes; no existing row is written or altered.
--
-- WHY (owner 2026-09-30: 「balance collection 需要 request key in 如果是超过14天
-- from today - 只有 admin 可以看到 request」). Since 2026-09-23 (#4240) a keyed-in
-- payment whose slip date is more than 14 days old is refused outright unless the
-- caller holds `scm.payment.backdate`. The money is real, though — a balance
-- collected three weeks ago still has to reach the order. So the refusal becomes
-- a REQUEST: the collector keys the payment exactly as before plus a reason, it
-- waits here, and a holder of `scm.payment.backdate` approves (the payment is
-- booked then, through the one write core) or rejects it.
--
-- SHAPE. The request holds the whole payment it would book — method fields,
-- amount, slip date, collector, the committed R2 key of the slip if one was
-- attached — so an approval books exactly what was asked, and nothing counts
-- toward the order's paid total until then (the payments ledger never sees a
-- pending row). payment_id links the booked row once approved.
--   status   REQUESTED -> APPROVED | REJECTED | WITHDRAWN
--   requested_by / decided_by  public.users.id (integer) of the REAL Houzs caller,
--            with a name snapshot, for the same reason as document_cancel_requests:
--            the SCM bridge pins every caller's scm.staff uuid to one system id.
--
-- Plain CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS, schema-qualified,
-- no DO block (pg-migrate splits on ";\n"), no enum (a text CHECK is reversible).

CREATE TABLE IF NOT EXISTS scm.so_payment_backdate_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         bigint NOT NULL,
  so_doc_no          text NOT NULL,
  status             text NOT NULL DEFAULT 'REQUESTED'
                     CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  reason             text NOT NULL,
  paid_at            date NOT NULL,
  method             text NOT NULL,
  merchant_provider  text,
  installment_months integer,
  online_type        text,
  approval_code      text,
  amount_sen         bigint NOT NULL CHECK (amount_sen > 0),
  account_sheet      text,
  collected_by       uuid,
  note               text,
  slip_key           text,
  requested_by       integer NOT NULL,
  requested_by_name  text,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  decided_by         integer,
  decided_by_name    text,
  decided_at         timestamptz,
  decision_note      text,
  payment_id         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_so_payment_backdate_requests_company_status
  ON scm.so_payment_backdate_requests (company_id, status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_so_payment_backdate_requests_doc
  ON scm.so_payment_backdate_requests (so_doc_no, requested_at DESC);
