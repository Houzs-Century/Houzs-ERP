-- ----------------------------------------------------------------------------
-- 0162 — Customer marketing demographics captured ON the Sales Order (hidden).
--
-- (Renumbered 0158 -> 0162: main's 0158_assr_inspection_visit landed first, so
-- this cutover migration took the next free number. Prod's _pg_migrations row
-- was relabelled 0158 -> 0162 to match; columns were already applied.)
--
-- Owner ruling (2026-07-20, POS cutover #14): the POS handover collects three
-- customer marketing fields — race / birthday / gender (pos-handover-so.ts:
-- customerRace / customerBirthday / customerGender). 2990's design persisted
-- these to the customers table via upsert_customer_by_name_phone; the owner
-- wants them slotted onto the SO instead ("pos 那些來的 gender 都在 SO 開槽可是
-- hide 起來"), captured at create and NEVER shown on the SO/PDF/UI.
--
-- Before this, the Houzs SO-create (mfg-sales-orders.ts) passed only
-- name/phone/email to the customer upsert and had NO column for these three, so
-- every value the POS sent was silently DROPPED.
--
-- Additive + reversible: three nullable columns, no default, no backfill. Only
-- POS-origin SO-create populates them; every existing + non-POS SO leaves them
-- NULL. No index (never queried — capture-only, hidden). Idempotent so the
-- pg-migrate runner (and a manual re-apply) is always safe.
-- ----------------------------------------------------------------------------

ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS customer_race     text;
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS customer_birthday date;
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS customer_gender   text;

COMMENT ON COLUMN scm.mfg_sales_orders.customer_race     IS 'POS handover marketing demographic (customerRace). Capture-only, hidden — never on SO/PDF/UI. Cutover #14, mig 0162.';
COMMENT ON COLUMN scm.mfg_sales_orders.customer_birthday IS 'POS handover marketing demographic (customerBirthday, ISO date). Capture-only, hidden. Cutover #14, mig 0162.';
COMMENT ON COLUMN scm.mfg_sales_orders.customer_gender   IS 'POS handover marketing demographic (customerGender). Capture-only, hidden. Cutover #14, mig 0162.';
