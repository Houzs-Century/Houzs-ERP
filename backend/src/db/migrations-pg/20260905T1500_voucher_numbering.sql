-- 20260905T1500_voucher_numbering.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.acc_bank_letters;
--           DROP TABLE IF EXISTS scm.acc_numbering;
--           UPDATE scm.payment_vouchers SET pv_number = '2990-PV-2609-001'
--             WHERE pv_number = '2990-Draft-2609-001' AND status = 'DRAFT';
--           UPDATE scm.payment_vouchers SET pv_number = '2990-PV-2609-002'
--             WHERE pv_number = '2990-Draft-2609-002' AND status = 'DRAFT';
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   Two small config tables, empty until the owner fills them, plus the
--   renumbering of exactly TWO rows — the only payment vouchers in existence,
--   both DRAFT (measured 2026-09-05), whose formal-series numbers the owner
--   asked to reclaim (现有 2 张 draft 收回旧号). Nothing references a PV by
--   number: attachments, approvals and journal links ride on the id, and no
--   journal exists for a draft (posting happens at approve, after the formal
--   number is minted under the item-8b flow).
--
-- WHY (owner, 2026-09-05, GL redesign item 8):
--   • scm.acc_bank_letters — the per-bank prefix letter (Maybank M → the
--     voucher series 2990-MPV-YYMM-NNN). HE maintains it: a new bank means he
--     types one letter on the setup screen, never a deploy. UNIQUE per
--     (company, letter): two banks sharing a letter would share a number
--     series, which is the collision the letter exists to prevent.
--   • scm.acc_numbering — the suffix width (3 → -001, up to 5), his 如果到时
--     我要 2990-MPV-2609-0001 呢. Width is display-only; parsing accepts any
--     length, so changing it renumbers nothing.
--   • The two UPDATEs park the existing drafts on the Draft series so the
--     formal 2990-…PV-… numbers stay untouched until CHECKED mints them
--     (draft 不占正式号 — his numbering rule).
--
-- Additive + idempotent: IF NOT EXISTS on the tables; the UPDATEs match the
-- exact old number AND DRAFT status, so a re-run finds nothing to touch.

SET search_path = scm, public;

CREATE TABLE IF NOT EXISTS scm.acc_bank_letters (
  company_id   integer NOT NULL,
  account_code text NOT NULL,
  letter       text NOT NULL CHECK (letter ~ '^[A-Z]{1,3}$'),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text,
  PRIMARY KEY (company_id, account_code),
  UNIQUE (company_id, letter)
);

CREATE TABLE IF NOT EXISTS scm.acc_numbering (
  company_id integer PRIMARY KEY,
  doc_digits integer NOT NULL DEFAULT 3 CHECK (doc_digits BETWEEN 3 AND 5),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

UPDATE scm.payment_vouchers SET pv_number = '2990-Draft-2609-001'
  WHERE pv_number = '2990-PV-2609-001' AND status = 'DRAFT';
UPDATE scm.payment_vouchers SET pv_number = '2990-Draft-2609-002'
  WHERE pv_number = '2990-PV-2609-002' AND status = 'DRAFT';
