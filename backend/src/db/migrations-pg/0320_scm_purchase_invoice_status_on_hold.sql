-- 0320_scm_purchase_invoice_status_on_hold.sql
-- Add 'ON_HOLD' to scm.purchase_invoice_status so a Purchase Invoice can be
-- paused — a disputed supplier bill that must not be paid while it is queried.
--
-- Owner, 2026-08-21: "PO 加 hold / GR / PI also hold".
--
-- WHAT IT BLOCKS (the app half, not this file): a Purchase Invoice on hold
-- cannot be settled by a Payment Voucher. Unlike the PO and the GRN, this one
-- is NOT free — the settle loop reads invoices by id and had no status gate, so
-- the refusal is written explicitly in payment-vouchers.ts. That asymmetry is
-- deliberate and worth knowing: two of the three holds are enforced by
-- allow-lists that already existed, and this one is enforced by a guard that
-- did not.
--
-- ALTER TYPE ... ADD VALUE only — kept ALONE in its own file. Same shape as
-- 0044, which added DRAFT to this same type.
--
-- REVERSAL: IRREVERSIBLE — Postgres has no DROP VALUE for an enum type.
-- Retiring the label means removing it from the app's vocabulary; the type
-- keeps it for ever.
-- Verified against: production schema read of scm.purchase_invoice_status on
-- 2026-08-21 — POSTED, PARTIALLY_PAID, PAID, CANCELLED, plus DRAFT from mig
-- 0044. No row carries ON_HOLD, because the label does not exist yet.

SET search_path = scm, public;

ALTER TYPE scm.purchase_invoice_status ADD VALUE IF NOT EXISTS 'ON_HOLD';
