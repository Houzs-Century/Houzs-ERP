-- 20261024T1000_scm_threepl_from_ap.sql
-- REVERSAL:
--   ALTER TABLE scm.threepl_do_charges DROP COLUMN IF EXISTS ap_invoice_id;
--   ALTER TABLE scm.threepl_companies DROP COLUMN IF EXISTS supplier_id;
--   Revert the code first (scm/routes/threepl-from-ap.ts writes both; the
--   3PL invoices list reads ap_invoice_id). Dropping them loses which AP
--   invoice a charge came from and which supplier a carrier bills as; the
--   charges themselves stay.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: two new
-- NULLABLE columns and one partial index; no existing row is written or
-- altered (scm.threepl_do_charges holds 0 rows on prod, 2026-10-23).
--
-- WHY (owner 2026-10-23, 「先做」): the 3PL invoices tab is filled FROM the AP
-- invoice Finance already keyed — its attached bill (MSJ's handwritten sheet,
-- NEST LIVING's list, EU LOGISTICS' slips) is read, every line matched to a
-- delivery order, and what the carrier charged per DO is tallied against the
-- rate card. A charge keeps the AP invoice it came from, so reading the same
-- bill again replaces its rows instead of adding to them; a carrier keeps the
-- supplier it bills as, so the next bill from that supplier picks the carrier
-- by itself.

SET search_path = public, scm;

ALTER TABLE scm.threepl_do_charges
  ADD COLUMN IF NOT EXISTS ap_invoice_id uuid NULL REFERENCES scm.ap_invoices(id) ON DELETE SET NULL;

ALTER TABLE scm.threepl_companies
  ADD COLUMN IF NOT EXISTS supplier_id uuid NULL REFERENCES scm.suppliers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_threepl_do_charges_ap_invoice
  ON scm.threepl_do_charges (company_id, ap_invoice_id)
  WHERE ap_invoice_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
