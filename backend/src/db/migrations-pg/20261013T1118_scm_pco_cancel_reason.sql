-- 20261013T1118_scm_pco_cancel_reason.sql
-- PCO cancellations need to add a remarks column, referencing SO amendments.

ALTER TABLE scm.purchase_consignment_orders ADD COLUMN IF NOT EXISTS cancel_reason text;

-- REVERSAL: ALTER TABLE scm.purchase_consignment_orders DROP COLUMN IF EXISTS cancel_reason;