-- 20261014T1500_scm_threepl_do_charges.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.threepl_do_charges;
--   Revert the code first (scm/routes/threepl-do-charges.ts is the only reader
--   and writer). Dropping it loses the keyed-in 3PL invoice amounts.
--   GRANTS: the one GRANT below goes with the table.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new
-- empty table and its indexes; no existing row is written or altered.
--
-- WHY (HC-0031, Mr Lim, IT Hub): "All fees are preset and calculated after
-- delivery. The transporter sends an invoice and we just tally." Today the only
-- 3PL amount is scm.trips.three_pl_cost_sen, typed BEFORE delivery, and prod has
-- 0 trips (read-only probe, 14 Oct) - 3PL work is not planned as trips. So the
-- billed amount hangs on the DELIVERY ORDER: one row per (DO, carrier), keyed in
-- after delivery from the carrier's invoice, tallied against the rate card.
--
-- company_id is the PAYING company (the active company that holds the carrier
-- and its rate card). The DO may belong to a related company (HOUZS pays a 3PL
-- for 2990 deliveries - prod payment request, 13 Oct), so the DO is NOT scoped
-- to company_id; the route checks it against the caller's allowed companies.
-- One DO can carry two carriers (East Malaysia: sea leg + last mile), hence the
-- unique key includes the carrier.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS scm.threepl_do_charges (
  id                  uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id          bigint      NOT NULL REFERENCES public.companies(id),
  do_id               uuid        NOT NULL REFERENCES scm.delivery_orders(id) ON DELETE CASCADE,
  threepl_company_id  uuid        NOT NULL REFERENCES scm.threepl_companies(id),
  invoice_no          text,
  invoice_date        date,
  billed_sen          bigint      NOT NULL CHECK (billed_sen >= 0),
  note                text,
  created_by          bigint,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT threepl_do_charges_uq UNIQUE (company_id, do_id, threepl_company_id)
);
CREATE INDEX IF NOT EXISTS idx_threepl_do_charges_invoice
  ON scm.threepl_do_charges (company_id, threepl_company_id, invoice_no);
CREATE INDEX IF NOT EXISTS idx_threepl_do_charges_date
  ON scm.threepl_do_charges (company_id, invoice_date DESC);

-- Same as 0061: RLS on, no policies; the Worker's service_role bypasses RLS.
ALTER TABLE scm.threepl_do_charges ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE scm.threepl_do_charges TO service_role;

NOTIFY pgrst, 'reload schema';
