-- 20261110T1300_assr_supplier_return_eta.sql
-- REVERSAL: ALTER TABLE public.assr_supplier_returns DROP COLUMN IF EXISTS expected_return_at;
--   The column is new and nullable; dropping it loses only the ETA dates typed
--   on supplier return trips. GRANTS: none touched.
--
-- WHY (Operation Dept, 2026-11-09, "Supplier Returns: nak tambah Expected Return
-- Date (ETA) supaya senang track barang yang masih dekat supplier"). Each trip
-- had the date it went out (pickup_at) and the date it came back (returned_at),
-- but not the date the supplier promised it back, so staff could not see which
-- items were overdue at the supplier. YYYY-MM-DD text like the other two dates,
-- checked at the API. Not mirrored onto assr_cases: the board and the HC sheet
-- do not read it.
SET search_path = public;

ALTER TABLE public.assr_supplier_returns ADD COLUMN IF NOT EXISTS expected_return_at text;
