-- 20261125T1100_acc_opening_bill_places.sql
--
-- WHY. Owner 2026-11-25 (「要，做 A」): where a payment of an opening bill
-- (an AutoCount bill brought over at go-live, scm.ap_invoices.opening) reads in
-- the Cash Flow, kept by Finance — per supplier, and per bill where one
-- supplier's bills are for different things (「根据purpose去放」). A bill's own
-- choice comes first, then its supplier's; with neither, the report reads the
-- supplier's own bills in the ERP, else the creditor control. Cash Flow only:
-- nothing posts, no journal moves.
--
-- A choice names an account of the company's chart (account_code) or a Cash
-- Flow category (category_id, an id of the `rp` layout tree), exactly one. No
-- row = no choice. The route checks the supplier and the bill are the
-- company's, the bill is an opening bill, the account is the company's and the
-- category is on the tree.
--
-- Additive, idempotent, schema-qualified, no data. RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   DROP TABLE IF EXISTS scm.acc_opening_bill_places;
--   DROP TABLE IF EXISTS scm.acc_opening_supplier_places;
--   Revert the code first. Dropping the tables loses the choices Finance made
--   and nothing in the books.
--   GRANTS: none to re-apply.

CREATE TABLE IF NOT EXISTS scm.acc_opening_supplier_places (
  company_id   bigint      NOT NULL,
  supplier_id  uuid        NOT NULL REFERENCES scm.suppliers(id) ON DELETE CASCADE,
  account_code text,
  category_id  text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text,
  PRIMARY KEY (company_id, supplier_id),
  CONSTRAINT acc_opening_supplier_places_one CHECK (num_nonnulls(account_code, category_id) = 1)
);

CREATE TABLE IF NOT EXISTS scm.acc_opening_bill_places (
  company_id    bigint      NOT NULL,
  ap_invoice_id uuid        NOT NULL REFERENCES scm.ap_invoices(id) ON DELETE CASCADE,
  account_code  text,
  category_id   text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  PRIMARY KEY (company_id, ap_invoice_id),
  CONSTRAINT acc_opening_bill_places_one CHECK (num_nonnulls(account_code, category_id) = 1)
);

-- Only the Worker reads or writes them, like the newest acc tables: row level
-- security on with no policy (the Worker's roles bypass it), the service role
-- granted by name.
ALTER TABLE scm.acc_opening_supplier_places ENABLE ROW LEVEL SECURITY;
ALTER TABLE scm.acc_opening_bill_places ENABLE ROW LEVEL SECURITY;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON scm.acc_opening_supplier_places TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON scm.acc_opening_bill_places TO service_role;
  END IF;
END
$grant$;

COMMENT ON TABLE scm.acc_opening_supplier_places IS
  'Cash Flow only: where payments of a supplier''s opening bills read - an account or a Cash Flow category. Nothing posts.';
COMMENT ON TABLE scm.acc_opening_bill_places IS
  'Cash Flow only: where payments of one opening bill read, before its supplier''s choice - an account or a Cash Flow category. Nothing posts.';
