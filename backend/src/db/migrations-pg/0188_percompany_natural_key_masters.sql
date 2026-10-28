-- 0188_percompany_natural_key_masters.sql — per-company UNIQUE/PK on the
-- natural-key MASTER tables, so a THIRD company can hold its own codes without
-- colliding with company 1 (HOUZS) / company 2 (2990).
--
-- WHY NOW. Onboarding company 3 is mostly config, EXCEPT for the master tables
-- that key on a human-chosen code a new company will legitimately reuse (its own
-- 200-0000 GL account, its own model / product / promo codes). Those still carry
-- a GLOBAL unique/PK and would reject company 3's codes. This is the one-time
-- batch that flips them to (company_id, <key>). Evidence + table list:
-- docs/MULTICOMPANY-SCALING.md section 3. This is the companion to migration
-- 0087, which already did suppliers / products / warehouses / special_addons but
-- DEFERRED these four:
--   * accounts.account_code — 0087 left it GLOBAL because it is an FK target
--     (journal_entry_lines + payment_voucher(_lines)); finished here (see part 4).
--   * product_models / product_dept_configs / pwp_codes — not in 0087's set.
--
-- WHY SAFE ON EXISTING DATA. Loosening a GLOBAL unique to (company_id, key) can
-- never fail: every existing row already satisfied the stricter global unique,
-- so it trivially satisfies the per-company one. company_id is NOT NULL on all
-- four tables (migration 0083), so no partial-index handling is needed. The only
-- non-trivial case is accounts' three inbound FKs; they are re-added NOT VALID
-- (part 4) so this migration performs NO existing-row scan and cannot fail on
-- deploy.
--
-- HOUSE STYLE. Additive, idempotent (re-run-safe), IF EXISTS / IF NOT EXISTS,
-- schema-qualified, no runtime self-apply. pg-migrate runs the whole file in one
-- transaction (scripts/pg-migrate.mjs) and the splitter is dollar-quote aware
-- (scripts/lib/split-sql.mjs), so the PL/pgSQL DO blocks below may span lines.

SET search_path = scm, public;

-- 1) product_models: UNIQUE(model_code, category) -> (company_id, model_code, category)
-- The old key is a plain UNIQUE INDEX and is NOT an FK target — every FK to
-- product_models references its uuid `id`, never model_code — so this is a pure
-- index swap.
DROP INDEX IF EXISTS scm.product_models_code_category_unique;
CREATE UNIQUE INDEX IF NOT EXISTS product_models_company_code_category_unique
  ON scm.product_models (company_id, model_code, category);

-- 2) product_dept_configs: PRIMARY KEY(product_code) -> (company_id, product_code)
-- No FK references product_code, so the PK can be recomposed directly. Guarded on
-- the new PK name so a re-run is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_dept_configs_company_pkey') THEN
    ALTER TABLE scm.product_dept_configs DROP CONSTRAINT IF EXISTS product_dept_configs_pkey;
    ALTER TABLE scm.product_dept_configs ADD CONSTRAINT product_dept_configs_company_pkey PRIMARY KEY (company_id, product_code);
  END IF;
END $$;

-- 3) pwp_codes: PRIMARY KEY(code) -> (company_id, code)
-- No FK references code. The code minter (scm/routes/pwp-codes.ts) already stamps
-- company_id and retries on PK collision, so a composite PK preserves it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pwp_codes_company_pkey') THEN
    ALTER TABLE scm.pwp_codes DROP CONSTRAINT IF EXISTS pwp_codes_pkey;
    ALTER TABLE scm.pwp_codes ADD CONSTRAINT pwp_codes_company_pkey PRIMARY KEY (company_id, code);
  END IF;
END $$;

-- 4) accounts: UNIQUE(account_code) -> (company_id, account_code) + composite FKs
-- accounts.account_code is referenced by three FKs (journal_entry_lines.account_code,
-- payment_vouchers.credit_account_code, payment_voucher_lines.debit_account_code),
-- so the global unique cannot be dropped while they exist. A per-company account
-- code ALSO makes a bare account_code FK ambiguous (which company's 200-0000?), so
-- these FKs must become composite for correctness, not just to unblock the drop.
--
-- The drops below are DYNAMIC (by shape, not by name): because this DB's scm
-- schema is restored from scripts/scm-schema/*.sql rather than built by numbered
-- migrations, a hard-coded constraint name that is subtly wrong on prod would
-- silently leave the global key in place (drop is a no-op) or block the deploy.
-- Matching "single-column {unique|FK} whose column is account_code" is robust to
-- naming AND self-excludes the 2-column composites added here, so a re-run is a
-- no-op.
--
-- The re-added FKs are NOT VALID: they enforce referential integrity on all
-- FUTURE writes (a company-3 journal/PV line must point at a company-3 account)
-- but perform NO scan of existing rows, so the migration cannot fail on data it
-- cannot see from here. Existing rows are already consistent — each line was
-- written under the same company as its account, and the old single-column FK
-- guaranteed the code existed — so a later VALIDATE CONSTRAINT can flip them to
-- validated once confirmed against prod (follow-up; see PR body).

-- 4a) drop every single-column FK that targets accounts.account_code
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT rel.relname AS tbl, con.conname AS name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_class fref ON fref.oid = con.confrelid
    JOIN pg_namespace fn ON fn.oid = fref.relnamespace
    WHERE con.contype = 'f'
      AND fn.nspname = 'scm'
      AND fref.relname = 'accounts'
      AND array_length(con.conkey, 1) = 1
      AND (SELECT attname FROM pg_attribute WHERE attrelid = con.confrelid AND attnum = con.confkey[1]) = 'account_code'
  LOOP
    EXECUTE format('ALTER TABLE scm.%I DROP CONSTRAINT %I', r.tbl, r.name);
  END LOOP;
END $$;

-- 4b) drop the single-column UNIQUE on accounts.account_code (name-agnostic)
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname AS name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE con.contype = 'u'
      AND n.nspname = 'scm'
      AND rel.relname = 'accounts'
      AND array_length(con.conkey, 1) = 1
      AND (SELECT attname FROM pg_attribute WHERE attrelid = con.conrelid AND attnum = con.conkey[1]) = 'account_code'
  LOOP
    EXECUTE format('ALTER TABLE scm.accounts DROP CONSTRAINT %I', r.name);
  END LOOP;
END $$;

-- 4c) the new per-company unique (a named CONSTRAINT, not a bare index, so it is
-- an unambiguous FK target for the composite FKs re-added below)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_company_account_code_unique') THEN
    ALTER TABLE scm.accounts ADD CONSTRAINT accounts_company_account_code_unique UNIQUE (company_id, account_code);
  END IF;
END $$;

-- 4d) re-add the three FKs as composite (company_id, code) -> accounts, NOT VALID
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_entry_lines_company_account_fk') THEN
    ALTER TABLE scm.journal_entry_lines
      ADD CONSTRAINT journal_entry_lines_company_account_fk
      FOREIGN KEY (company_id, account_code)
      REFERENCES scm.accounts (company_id, account_code) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_vouchers_company_credit_account_fk') THEN
    ALTER TABLE scm.payment_vouchers
      ADD CONSTRAINT payment_vouchers_company_credit_account_fk
      FOREIGN KEY (company_id, credit_account_code)
      REFERENCES scm.accounts (company_id, account_code) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_voucher_lines_company_debit_account_fk') THEN
    ALTER TABLE scm.payment_voucher_lines
      ADD CONSTRAINT payment_voucher_lines_company_debit_account_fk
      FOREIGN KEY (company_id, debit_account_code)
      REFERENCES scm.accounts (company_id, account_code) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
