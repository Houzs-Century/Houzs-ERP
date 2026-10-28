-- 0068_scan_dedup.sql
-- Duplicate-upload warning for the background scan job (owner 2026-07-04:
-- 重复上传预警 / "已经开过单").
--
-- The /scan-so/enqueue pipeline (and /extract) now checks, BEFORE creating the
-- DRAFT SO, whether the uploaded slip was already turned into an SO:
--   rule A (image)   — same photo sha256 as a so_scan_samples row from the last
--                      30 days whose scan job already minted an SO;
--   rule B (content) — an existing non-cancelled SO with the same normalized
--                      customer phone AND (same customer SO ref, or same slip
--                      date + same grand total).
-- A suspected duplicate STILL creates the DRAFT (the owner reviews); the SO
-- note is prefixed "POSSIBLE DUPLICATE of <doc_no>" and the doc_no of the
-- suspected original lands here so the mobile Scan screen can surface it.
--
--   duplicate_of   doc_no of the suspected original SO (text, null = clean).
--
-- The three indexes keep the check to small indexed lookups:
--   so_scan_samples(image_sha256)  — rule A step 1 (hash -> recent samples)
--   scan_jobs(sample_id)           — rule A step 2 (samples -> minted SO)
--   mfg_sales_orders(phone)        — rule B (phone -> candidate SOs; also the
--                                    pattern the cross-category auto-match
--                                    already queries on every customer change)
--
-- DEPLOY ORDER: apply BEFORE deploying the worker build that selects
-- duplicate_of (dual-migration-tree rule: PG prod first, code second).
--
-- Postgres-only — SCM has no D1 twin (precedent: 0066/0067; an empty D1 stub
-- breaks the D1 test runner). ADDITIVE + idempotent. Outer BEGIN;/COMMIT;
-- omitted — pg-migrate.mjs wraps the whole file in one transaction.

ALTER TABLE scm.scan_jobs
  ADD COLUMN IF NOT EXISTS duplicate_of text;

CREATE INDEX IF NOT EXISTS so_scan_samples_image_sha256_idx
  ON scm.so_scan_samples (image_sha256)
  WHERE image_sha256 IS NOT NULL;

CREATE INDEX IF NOT EXISTS scan_jobs_sample_id_idx
  ON scm.scan_jobs (sample_id)
  WHERE sample_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS mfg_sales_orders_phone_idx
  ON scm.mfg_sales_orders (phone)
  WHERE phone IS NOT NULL;
