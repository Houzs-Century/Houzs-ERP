-- 20260907T1700_pv_purpose_customer_refund.sql
-- REVERSAL: none possible — Postgres cannot drop a value from an enum. Leaving
--   CUSTOMER_REFUND on scm.payment_voucher_purpose is harmless once the code
--   that writes it is gone: no row carries it until the refund voucher ships,
--   and a value nothing writes is a word in a list.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   One enum value added. No row is read or written.
--
-- WHY (owner 2026-09-07, after the Customer Refund check: 按 1、2、3 的顺序做).
-- A refund to a customer is the same paper as a payment voucher — money leaves
-- a bank/cash account through the four-layer cycle — with the customer where
-- the supplier would be: Dr the AR control (300-0000, that customer) / Cr the
-- money account, which offsets the Cr AR the customer's own payment booked.
-- The document type IS the purpose (payment-voucher.md §0c), so the third
-- kind is a third purpose value, next to SUPPLIER_PAYMENT and OTHER.
--
-- ALTER TYPE ... ADD VALUE only — kept ALONE in its own file (0040's rule):
-- pg-migrate wraps each file in one transaction, and Postgres forbids USING a
-- freshly-added enum value in the transaction that adds it, so no row may
-- write CUSTOMER_REFUND here. The columns the refund needs land in the next
-- file. Idempotent via IF NOT EXISTS.

SET search_path = scm, public;

ALTER TYPE scm.payment_voucher_purpose ADD VALUE IF NOT EXISTS 'CUSTOMER_REFUND';
