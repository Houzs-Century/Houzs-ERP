-- 0034_so_scan_receipt_image.sql
-- Sales Order ICR — persist a SECOND scanned photo: the printed card-terminal
-- payment RECEIPT, alongside the existing handwritten order-slip image (0033).
--
-- The "Scan Order" flow (POST /scan-so/extract) can now carry TWO photos in one
-- scan: a HANDWRITTEN order slip AND a PRINTED card-terminal payment receipt.
-- Claude classifies each uploaded image (order_slip vs payment_receipt); the
-- order-slip image keeps the existing `scan-slips/{sampleId}` key (image_key,
-- migration 0033), and the receipt is stored at `scan-slips/{sampleId}-receipt`.
-- This migration adds the storage hooks for the receipt key so it is kept in R2
-- and carried onto the created Sales Order as "Payment Receipt" proof:
--   • scm.so_scan_samples.receipt_image_key  — the R2 key for the receipt image
--     saved at extract time (NULL when no receipt was uploaded / classify /
--     R2 put failed).
--   • scm.mfg_sales_orders.receipt_image_key — the same key copied onto the SO
--     header when the operator opens the reviewed slip in New SO, so the SO
--     Detail page can authed-serve the receipt back as proof.
--
-- ADDITIVE + idempotent. No data migration. Outer BEGIN;/COMMIT; omitted —
-- pg-migrate.mjs wraps the whole file in one transaction.

ALTER TABLE scm.so_scan_samples ADD COLUMN IF NOT EXISTS receipt_image_key text;
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS receipt_image_key text;
