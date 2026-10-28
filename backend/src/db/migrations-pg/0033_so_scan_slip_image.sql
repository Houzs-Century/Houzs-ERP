-- 0033_so_scan_slip_image.sql
-- Sales Order ICR — persist the uploaded handwritten slip photo.
--
-- The "Scan Order" flow (POST /scan-so/extract) uploads phone photo(s) of a
-- handwritten showroom sale-order slip. Until now the image was sent to Claude
-- and discarded. This migration adds the storage hooks so the slip image is
-- kept in R2 (SO_ITEM_PHOTOS bucket, `scan-slips/{sampleId}` key) and carried
-- onto the created Sales Order as "Original Slip" proof:
--   • scm.so_scan_samples.image_key  — the R2 key for the slip image saved at
--     extract time (NULL when the upload was a PDF or the R2 put failed).
--   • scm.mfg_sales_orders.slip_image_key — the same key copied onto the SO
--     header when the operator opens the reviewed slip in New SO, so the SO
--     Detail page can authed-serve the image back as proof.
--
-- ADDITIVE + idempotent. No data migration. Outer BEGIN;/COMMIT; omitted —
-- pg-migrate.mjs wraps the whole file in one transaction.

ALTER TABLE scm.so_scan_samples ADD COLUMN IF NOT EXISTS image_key text;
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS slip_image_key text;
