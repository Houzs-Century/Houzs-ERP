-- 20260907T1600_acc_official_receipts.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.acc_official_receipts;
--   GRANTS: none to re-apply — like 0352's scm.acc_pv_files and 20260906T2100's
--   scm.acc_ap_invoice_files, the table rides the scm schema's default
--   privileges (service_role); this file grants nothing, so the reverse
--   re-grants nothing.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   One new empty table under a NEW name. Nothing existing is read, written
--   or altered.
--
-- WHY (docs/bugs/0658). 20260905T1800_official_receipts.sql created the
-- Official Receipt table as `CREATE TABLE IF NOT EXISTS scm.acc_receipts` —
-- a name 0351_acc_general_receipts.sql (2026-09-03) had already given the
-- general money-in receipt (/scm/receipts, receipt_number / payer_name…).
-- On every database that statement was a silent no-op: the tracker recorded
-- the file as applied (prod: 2026-09-04 23:24 UTC), and the OR module's
-- columns — or_number, payment_source, payment_id, channel_account_code… —
-- never existed. Every receipt birth failed best-effort (logged, never
-- surfaced), /scm/official-receipts could not load, and the settlement hook
-- formalised nothing. 20260905T1800 stays exactly as it is (an applied
-- migration's body is never edited); this file gives the module its own
-- table under its own name, and the code reads it from here. The one thing
-- 20260905T1800 did create — acc_receipts_company_status_idx on the general
-- table's (company_id, status, created_at) — is harmless and stays.
--
-- Columns are 20260905T1800's, verbatim (that file says what each means):
--   • or_number       — draft series at birth ({co}DraftOR-YYMM-NNN), the
--                       channel series at formalisation. UNIQUE.
--   • payment_source + payment_id — WHICH payment this receipt is for;
--                       UNIQUE, one receipt per payment, forever.
--   • channel_account_code — the money account the formal series was drawn
--                       from (320-0000 for cash, the bank otherwise); NULL
--                       while draft.
--
-- Additive + idempotent (IF NOT EXISTS) — on a NEW name, so IF NOT EXISTS
-- cannot repeat the mistake; tests/officialReceiptsTable.test.ts pins that
-- no two migrations create one scm table name.

SET search_path = scm, public;

CREATE TABLE IF NOT EXISTS scm.acc_official_receipts (
  id                   bigserial PRIMARY KEY,
  company_id           integer NOT NULL,
  or_number            text NOT NULL UNIQUE,
  status               text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'FORMAL')),
  payment_source       text NOT NULL CHECK (payment_source IN ('SOPAY', 'SIPAY')),
  payment_id           text NOT NULL,
  doc_no               text,
  customer_name        text,
  method               text,
  amount_sen           bigint NOT NULL,
  paid_at              date,
  channel_account_code text,
  issued_at            timestamptz,
  issued_by            text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           text,
  UNIQUE (payment_source, payment_id)
);

CREATE INDEX IF NOT EXISTS acc_official_receipts_company_status_idx
  ON scm.acc_official_receipts (company_id, status, created_at DESC);
