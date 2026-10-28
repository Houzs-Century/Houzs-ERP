-- 0087: per-company unique codes so 2990 + Houzs can each hold the same code.
-- suppliers.code / products.sku / warehouses.code / special_addons.code are NOT
-- FK targets -> safe. accounts.account_code IS FK'd (journal/PV lines) -> left
-- GLOBAL (shared chart). Idempotent.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='suppliers_company_code_unique') THEN ALTER TABLE scm.suppliers DROP CONSTRAINT IF EXISTS suppliers_code_unique; ALTER TABLE scm.suppliers ADD CONSTRAINT suppliers_company_code_unique UNIQUE (company_id, code); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='products_company_sku_unique') THEN ALTER TABLE scm.products DROP CONSTRAINT IF EXISTS products_sku_unique; ALTER TABLE scm.products ADD CONSTRAINT products_company_sku_unique UNIQUE (company_id, sku); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='warehouses_company_code_unique') THEN ALTER TABLE scm.warehouses DROP CONSTRAINT IF EXISTS warehouses_code_unique; ALTER TABLE scm.warehouses ADD CONSTRAINT warehouses_company_code_unique UNIQUE (company_id, code); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='special_addons_company_code_unique') THEN ALTER TABLE scm.special_addons DROP CONSTRAINT IF EXISTS special_addons_code_unique; ALTER TABLE scm.special_addons ADD CONSTRAINT special_addons_company_code_unique UNIQUE (company_id, code); END IF; END $$;
