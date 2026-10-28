-- 0131_scm_suppliers_structured_address.sql
-- Give scm.suppliers the SAME structured address shape as the SO header
-- (address1-4 + city), so a Supplier-Pickup DP order auto-fills a supplier's
-- pickup address in the SO-Maintenance format the owner asked for (2026-07-18:
-- "supplier 的 address 也要根据顾客的格式") rather than the single free-text line
-- the master had. `state`, `postcode`, `area`, `country` already exist.
--
-- Additive DDL — the legacy single `address` column is KEPT (existing rows keep
-- their data, and dp-party's snapshotFromSupplier falls back to it when the
-- structured lines are empty). Populating the structured columns is the supplier
-- maintenance form's job (a follow-up); this only makes the shape available.
--
-- HOUSE STYLE: no runtime self-apply, IF NOT EXISTS, plain statements.

SET search_path = public, scm;

ALTER TABLE scm.suppliers ADD COLUMN IF NOT EXISTS address1 text;
ALTER TABLE scm.suppliers ADD COLUMN IF NOT EXISTS address2 text;
ALTER TABLE scm.suppliers ADD COLUMN IF NOT EXISTS address3 text;
ALTER TABLE scm.suppliers ADD COLUMN IF NOT EXISTS address4 text;
ALTER TABLE scm.suppliers ADD COLUMN IF NOT EXISTS city text;
