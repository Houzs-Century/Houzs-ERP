-- 0023_so_scan_samples.sql
-- Sales Order ICR — Scan Order (handwritten showroom sale-order slip OCR ->
-- New SO prefill). Ported from 2990's packages/db/migrations/0164_so_scan_samples.sql,
-- schema-qualified to scm.* (Houzs SCM lives in the dedicated `scm` Postgres schema)
-- and stripped of the RLS / is_staff() block (SCM is service-role only; those
-- helpers don't exist in Houzs). Outer BEGIN;/COMMIT; removed — pg-migrate.mjs
-- wraps the whole file in one transaction.
--
-- One row per /scan-so/extract call: the raw Claude extraction lands in
-- `extracted` (status EXTRACTED); when the operator reviews + opens the
-- New SO form, the corrected JSON is written to `corrected` (status
-- CONFIRMED). The 5 most recent CONFIRMED rows are injected back into the
-- extraction prompt as few-shot examples, so the extractor self-improves
-- from operator corrections (ported from HOOKKA's po_scan_samples pattern).
--
-- image_sha256 = SHA-256 of the first uploaded image, for dedupe/debugging.
--
-- salesperson = the sales rep who wrote the slip. Each rep has their own
-- handwriting/notation habits, so few-shot examples are filtered per rep
-- and a per-rep rules block (scm.so_scan_rules) is distilled from their
-- corrected samples — rules grouped by product category (sofa vs mattress
-- vs bedframe notation differs per rep). The reserved '__GLOBAL__' row holds
-- the cross-rep shared product-alias dictionary.
--
-- ADDITIVE + idempotent. No data migration.

CREATE TABLE IF NOT EXISTS scm.so_scan_samples (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  image_sha256  text,
  salesperson   text,
  extracted     jsonb,
  corrected     jsonb,
  status        text        NOT NULL DEFAULT 'EXTRACTED'
);

ALTER TABLE scm.so_scan_samples ADD COLUMN IF NOT EXISTS salesperson text;

CREATE INDEX IF NOT EXISTS idx_so_scan_samples_corrected
  ON scm.so_scan_samples (created_at DESC)
  WHERE corrected IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_so_scan_samples_salesperson
  ON scm.so_scan_samples (salesperson, created_at DESC)
  WHERE corrected IS NOT NULL;

CREATE TABLE IF NOT EXISTS scm.so_scan_rules (
  salesperson   text        PRIMARY KEY,
  rules         text        NOT NULL,
  sample_count  int,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
