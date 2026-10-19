-- 20261019T1100_scm_supplier_scan_codes.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.supplier_scan_codes;
--   Revert the code first (scm/lib/grn-scan-codes.ts reads and writes it). With
--   the table gone the scanner simply knows no taught codes again.
--   GRANTS: none to re-apply — the table rides the scm schema's default
--   privileges (service_role), like scm.job_progress.
--
-- WHAT THIS CHANGES: one new empty table. Nothing existing is touched.
--
-- WHY (HC-0119 / HC-0120, 2026-10-19): a supplier's delivery order prints the
-- supplier's own item codes (DIGLANT: T1MAMWA0MK for our AKEMI BULWARK MATT (K)).
-- The scanner matches codes against our item code and the PO line's supplier
-- SKU, so every DIGLANT row missed and the scan guessed. When the warehouse
-- tells the scan card which PO line a printed code is, the pair is kept here and
-- the next delivery order from that supplier matches it by code.
--
-- Not scm.supplier_material_bindings: that is the price / PO master, one row per
-- supplier + item, and its supplier_sku is what we print on our PO to the
-- supplier. A supplier can print several codes for one of our items (per
-- customer, per promotion), and a taught code must not change our PO.
--
--   printed_code  the code as the delivery order printed it
--   code_key      printed_code upper-cased with every non-alphanumeric dropped
--                 (grn-scan-match normalizeCode), the lookup key
--   item_code     our item code (scm.purchase_order_items.item_code)
--   created_by    public.users id of who taught it

CREATE TABLE IF NOT EXISTS scm.supplier_scan_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    BIGINT NOT NULL,
  supplier_id   UUID NOT NULL REFERENCES scm.suppliers(id) ON DELETE CASCADE,
  printed_code  TEXT NOT NULL,
  code_key      TEXT NOT NULL CHECK (code_key <> ''),
  item_code     TEXT NOT NULL,
  created_by    BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT supplier_scan_codes_one_per_code UNIQUE (company_id, supplier_id, code_key)
);
