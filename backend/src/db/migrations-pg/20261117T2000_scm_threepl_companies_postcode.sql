-- 20261117T2000_scm_threepl_companies_postcode.sql
-- Postcode / City / State on the 3PL company master (owner 2026-11-17: every
-- Delivery Planning job must carry Postcode + City + State, whatever its source,
-- so Last Mile shows them). A TRANSFER to an outsourced warehouse snapshots its
-- party from scm.threepl_companies, which had only a free-text `address` — so
-- every such job reached the board with no postcode, city or state.
--
-- Nullable: the 9 existing rows have none yet; the form fills them from the
-- my_localities postcode picker, and backend/scripts/fill-master-postcodes.mjs
-- proposes them from the address text (plan first). No data is written here.
--
-- REVERSAL: ALTER TABLE scm.threepl_companies DROP COLUMN IF EXISTS postcode; ALTER TABLE scm.threepl_companies DROP COLUMN IF EXISTS city; ALTER TABLE scm.threepl_companies DROP COLUMN IF EXISTS state;
ALTER TABLE scm.threepl_companies ADD COLUMN IF NOT EXISTS postcode TEXT NULL;
ALTER TABLE scm.threepl_companies ADD COLUMN IF NOT EXISTS city TEXT NULL;
ALTER TABLE scm.threepl_companies ADD COLUMN IF NOT EXISTS state TEXT NULL;
