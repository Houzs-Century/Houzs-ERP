-- 20260905T0900_acc_item_groups.sql
-- REVERSAL: DROP FUNCTION IF EXISTS scm.acc_register_item_group(text, text);
--           DROP TABLE IF EXISTS scm.acc_item_group_accounts;
--           DROP TABLE IF EXISTS scm.acc_item_groups;
--           (Any enum value the function added at runtime is retained — Postgres
--            has no DROP VALUE. A retained label with no products on it is inert:
--            every reader treats the enum as an open list.)
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   Two new empty-or-seeded tables and one function. Nothing existing is
--   altered: the mfg_product_category enums (public + scm, 9 labels each) are
--   only ever EXTENDED, and only at runtime through the function below — this
--   migration itself adds no labels.
--
-- WHY (owner, 2026-09-05, GL redesign item 1). The ledger is moving to the
-- AutoCount periodic shape: a purchase invoice must post Dr <purchase account
-- of the line's product group> / Cr supplier. That needs (a) the product
-- taxonomy to be a REGISTRY the owner can extend himself (今天 9 个品类是
-- enum 的 9 个值,他要能自己加 group), and (b) each group bound, per company,
-- to its four ledger accounts (owner: create 新 group 时强制绑定;绑定他自己
-- 维护). Products keep carrying the enum value in `category`; the registry
-- row is the accounting metadata AROUND that value, so the twelve existing
-- enum-typed columns (mfg_products, product_models, pwp_codes, pwp_rules ×
-- two schemas + two views) stay exactly as they are.
--
--   scm.acc_item_groups          — one row per group label; seeded with the 9
--                                  labels the enums hold today. is_active=false
--                                  hides a group from NEW products only.
--   scm.acc_item_group_accounts  — the four per-company bindings. A row's
--                                  presence IS "bound"; absence blocks the PI
--                                  posting for that group loudly (never
--                                  silently into OTHERS — owner's call). The
--                                  account columns are validated by the API
--                                  against the company's own chart (existence
--                                  + active); no FK, because scm.accounts rows
--                                  may be deactivated later and the read side
--                                  must keep resolving history.
--   scm.acc_register_item_group  — the ONE way a new group is born: validates
--                                  the label, extends BOTH enums (IF NOT
--                                  EXISTS, so replays are no-ops), registers
--                                  the row. SECURITY DEFINER because ALTER
--                                  TYPE needs the type owner, which API
--                                  callers are not. An ADD VALUE inside a
--                                  transaction is legal on this Postgres (12+);
--                                  the new label is usable from the NEXT
--                                  transaction, which is always the case here
--                                  (the group is created first, a product
--                                  picks it later).
--
-- Additive + idempotent throughout (IF NOT EXISTS / ON CONFLICT DO NOTHING);
-- the function is CREATE OR REPLACE.

SET search_path = scm, public;

CREATE TABLE IF NOT EXISTS scm.acc_item_groups (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz
);

INSERT INTO scm.acc_item_groups (code, name) VALUES
  ('SOFA',      'Sofa'),
  ('BEDFRAME',  'Bedframe'),
  ('MATTRESS',  'Mattress'),
  ('ACCESSORY', 'Accessory'),
  ('BEDLINES',  'Bedlines'),
  ('DINING',    'Dining'),
  ('DIFFUSER',  'Diffuser'),
  ('CARPET',    'Carpet'),
  ('SERVICE',   'Service')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS scm.acc_item_group_accounts (
  company_id              integer NOT NULL,
  group_code              text NOT NULL REFERENCES scm.acc_item_groups(code),
  purchase_account        text NOT NULL,
  sales_account           text NOT NULL,
  sales_return_account    text NOT NULL,
  purchase_return_account text NOT NULL,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              text,
  PRIMARY KEY (company_id, group_code)
);

CREATE OR REPLACE FUNCTION scm.acc_register_item_group(p_code text, p_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public, pg_temp
AS $fn$
BEGIN
  -- The label becomes an enum member and a document-facing code: keep it in
  -- the same shape the nine originals have, and refuse anything else by name.
  IF p_code !~ '^[A-Z][A-Z0-9_]{1,29}$' THEN
    RAISE EXCEPTION 'group code % must be 2-30 chars of A-Z, 0-9, _ starting with a letter', p_code;
  END IF;
  IF coalesce(trim(p_name), '') = '' THEN
    RAISE EXCEPTION 'group name is required';
  END IF;

  -- BOTH enums carry the taxonomy (the scm schema is a full sibling of
  -- public); extending only one would let a product save in one schema and
  -- fail in the other.
  EXECUTE format('ALTER TYPE public.mfg_product_category ADD VALUE IF NOT EXISTS %L', p_code);
  EXECUTE format('ALTER TYPE scm.mfg_product_category ADD VALUE IF NOT EXISTS %L', p_code);

  INSERT INTO scm.acc_item_groups (code, name)
  VALUES (p_code, trim(p_name))
  ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, is_active = true, updated_at = now();
END;
$fn$;

REVOKE ALL ON FUNCTION scm.acc_register_item_group(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scm.acc_register_item_group(text, text) TO service_role;
