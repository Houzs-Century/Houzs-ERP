-- 20260908T1400_scm_document_cancel_requests.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.document_cancel_requests;
--
-- WHAT THIS ADDS: one table, scm.document_cancel_requests — the request +
-- two-signature approval that now sits in front of cancelling a Sales Order or
-- a Purchase Order.
--
-- WHY (owner, 2026-09-08: 「SO 和 PO 取消的话需要 approval 2 层 — 已经输入原因」):
--   Until now a cancel was one click. On the Sales Order it is also FINAL —
--   `so_cancelled_final` refuses the way back, the deposit turns into customer
--   credit (creditFromCancelledSo) and an AutoCount cancel is queued that no
--   screen can undo (cancel_is_final). On the Purchase Order it releases the
--   SO quota and deletes the allocation sub-lines. Neither asked WHY, neither
--   asked a second person. The owner's rule is: the person who wants the
--   document cancelled writes the reason, and TWO approvers sign — level 1,
--   then level 2 — before the existing cancel path is allowed to run.
--
-- SHAPE. A request is its own row, not a marker on the document (unlike the
-- hold, mig 0324), because a document can be asked about more than once: a
-- rejected request must stay readable beside the one raised after it, and the
-- reason, the two signatures and who refused what are history worth keeping.
-- The document tables gain NO column. What the row carries:
--   doc_type / doc_key   'SO' + mfg_sales_orders.doc_no, or 'PO' + purchase_orders.id
--                        (each document's own route key — the Sales Order's
--                        whole route family is keyed by number, the PO's by id)
--   doc_number           what a person calls it, for the inbox and the notices
--   status               REQUESTED -> L1_APPROVED -> APPROVED -> EXECUTED
--                        or REJECTED (an approver refused) / WITHDRAWN (the
--                        requester pulled it back). APPROVED means both
--                        signatures are on it and the cancel may now run;
--                        EXECUTED is stamped by the cancel route's guard the
--                        moment the document is actually cancelled.
--   reason               the requester's words. NOT NULL — that is the point.
--   requested_by / l1_by / l2_by / rejected_by
--                        public.users.id (integer) of the REAL Houzs caller, with
--                        a name snapshot beside each, because the SCM bridge pins
--                        every caller's scm.staff row to one system uuid and a
--                        uuid here would read as the same person on every row.
--
-- ONE OPEN REQUEST PER DOCUMENT — the partial unique index. A second request
-- while one is still open is refused at the door (cancel_request_open) and the
-- index is the floor under that refusal.
--
-- Plain CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS, schema-
-- qualified, no DO block (pg-migrate splits on ";\n"), no enum (a text CHECK is
-- reversible; ADD VALUE is not). Additive and re-run safe.

CREATE TABLE IF NOT EXISTS scm.document_cancel_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         bigint NOT NULL,
  doc_type           text NOT NULL CHECK (doc_type IN ('SO', 'PO')),
  doc_key            text NOT NULL,
  doc_number         text NOT NULL,
  doc_status_at_request text,
  status             text NOT NULL DEFAULT 'REQUESTED'
                     CHECK (status IN ('REQUESTED', 'L1_APPROVED', 'APPROVED', 'EXECUTED', 'REJECTED', 'WITHDRAWN')),
  reason             text NOT NULL,
  requested_by       integer NOT NULL,
  requested_by_name  text,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  l1_by              integer,
  l1_by_name         text,
  l1_at              timestamptz,
  l2_by              integer,
  l2_by_name         text,
  l2_at              timestamptz,
  rejected_by        integer,
  rejected_by_name   text,
  rejected_at        timestamptz,
  reject_reason      text,
  executed_by        integer,
  executed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_document_cancel_request_open
  ON scm.document_cancel_requests (doc_type, doc_key)
  WHERE status IN ('REQUESTED', 'L1_APPROVED', 'APPROVED');

CREATE INDEX IF NOT EXISTS idx_document_cancel_requests_company_status
  ON scm.document_cancel_requests (company_id, status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_document_cancel_requests_doc
  ON scm.document_cancel_requests (doc_type, doc_key, requested_at DESC);
