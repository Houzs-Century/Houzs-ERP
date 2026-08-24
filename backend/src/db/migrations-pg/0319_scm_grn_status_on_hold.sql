-- 0319_scm_grn_status_on_hold.sql
-- Add 'ON_HOLD' to scm.grn_status so a Goods Received Note can be paused.
--
-- Owner, 2026-08-21: "PO 加 hold / GR / PI also hold".
--
-- WHAT IT BLOCKS (the app half, not this file): a GRN on hold cannot be turned
-- into a Purchase Invoice, because the billable-GRN read filters on
-- `.eq('status','POSTED')` — an ALLOW-list, so the block comes for free.
--
-- A HOLD DOES NOT TOUCH STOCK, and that is the point of preferring it to
-- CANCEL here. The inventory IN fires at the DRAFT -> POSTED transition and a
-- cancel writes the reversing OUT; holding a GRN changes no movement at all, so
-- it is a paperwork pause and not a stock event.
--
-- ALTER TYPE ... ADD VALUE only — kept ALONE in its own file, for the reason
-- 0040 states: pg-migrate wraps each file in one transaction and Postgres
-- forbids USING a freshly-added enum value in the transaction that adds it.
-- Same shape as 0043, which added DRAFT to this same type.
--
-- REVERSAL: IRREVERSIBLE — Postgres has no DROP VALUE for an enum type.
-- Retiring the label means removing it from the app's vocabulary; the type
-- keeps it for ever.
-- Verified against: production schema read of scm.grn_status on 2026-08-21 —
-- POSTED, CLOSED, CANCELLED, plus DRAFT from mig 0043. No row carries ON_HOLD,
-- because the label does not exist yet.

SET search_path = scm, public;

ALTER TYPE scm.grn_status ADD VALUE IF NOT EXISTS 'ON_HOLD';
