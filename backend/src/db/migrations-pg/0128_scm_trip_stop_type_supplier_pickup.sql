-- 0128_scm_trip_stop_type_supplier_pickup.sql
-- Add 'SUPPLIER_PICKUP' to scm.trip_stop_type — the 6th DP-Order job type the
-- owner asked for (2026-07-18): a run that collects goods FROM a supplier, its
-- party sourced from scm.suppliers rather than a customer.
--
-- ALTER TYPE ... ADD VALUE only — kept ALONE in its own file. pg-migrate.mjs
-- wraps each file in one transaction; Postgres forbids USING a freshly-added
-- enum value in the same transaction that adds it, so the dp_orders table that
-- references this value lands in the NEXT migration (0129). SET search_path = scm
-- so the unqualified type resolves to scm.* (pg-migrate's default excludes scm).
-- Idempotent via IF NOT EXISTS.

SET search_path = scm, public;

ALTER TYPE scm.trip_stop_type ADD VALUE IF NOT EXISTS 'SUPPLIER_PICKUP';
