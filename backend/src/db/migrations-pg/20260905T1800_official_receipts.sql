-- 20260905T1800_official_receipts.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.acc_receipts;
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   One new empty table. Nothing existing is read or written.
--
-- WHY (owner, 2026-09-05, GL redesign item 9). Every customer payment gets an
-- Official Receipt the moment it is recorded — born DRAFT (printable with a
-- DRAFT stamp) and turned FORMAL the moment the money is CONFIRMED, which is
-- when the formal number mints:
--   cash      → formal immediately (钱当场在手 — the drawer is its own proof);
--   card      → when merchant reconciliation confirms that payment (对不上的
--               钱,OR 永远停在 draft — the loop the owner wanted);
--   transfer  → a manual confirm, until bank reconciliation exists;
--   and ANY draft can be formalised by hand after a human verified the money
--   (客户催收据 — he checks the slip and presses confirm).
-- Formal series per CHANNEL, sharing the PV letter table: cash {co}COR-YYMM,
-- banks {co}{letter}OR-YYMM — so the formal-number order is the order money
-- was confirmed, per channel, and a slow recon never scrambles the cash run.
--
--   • or_number       — the draft series number at birth ({co}DraftOR-YYMM-NNN),
--                       replaced by the channel series at formalisation. UNIQUE:
--                       both series are real, collision-retried numbers.
--   • payment_source + payment_id — WHICH payment this receipt is for; UNIQUE,
--                       one receipt per payment, forever (a reprint reprints,
--                       never re-issues).
--   • channel_account_code — the money account the formal series was drawn
--                       from (320-0000 for cash, the bank otherwise); NULL
--                       while draft.
--
-- Additive + idempotent (IF NOT EXISTS).

SET search_path = scm, public;

CREATE TABLE IF NOT EXISTS scm.acc_receipts (
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

CREATE INDEX IF NOT EXISTS acc_receipts_company_status_idx
  ON scm.acc_receipts (company_id, status, created_at DESC);
