-- 20261103T0700_acc_bill_plans.sql
-- When Finance plans to pay a supplier bill (the owner's Claude Design, Money
-- out batch 4 step 7, 2026-11-03): a planned payment date beside the
-- supplier's due date, set from Supplier bills (Plan date), the bill's page and
-- the To do calendar (a bill dragged to another day). The calendar and Daily
-- Bank's upcoming payments read planned_on, else the due date; Overdue still
-- counts by the due date.
--
-- A side table, so Procurement's purchase_invoices is untouched. It posts
-- nothing. One row per bill: an AP bill (ap_invoices) or a purchase invoice
-- (purchase_invoices), by kind; clearing the plan deletes the row.
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified. RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   DROP TABLE IF EXISTS scm.acc_bill_plans;

CREATE TABLE IF NOT EXISTS scm.acc_bill_plans (
  company_id  bigint      NOT NULL,
  bill_kind   text        NOT NULL CHECK (bill_kind IN ('API', 'PI')),
  bill_id     uuid        NOT NULL,
  planned_on  date        NOT NULL,
  planned_by  text,
  planned_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, bill_kind, bill_id)
);
CREATE INDEX IF NOT EXISTS acc_bill_plans_day ON scm.acc_bill_plans (company_id, planned_on);
