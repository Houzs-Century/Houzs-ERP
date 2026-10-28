-- 0041_scm_sales_invoice_status_draft.sql
-- Add 'DRAFT' to scm.sales_invoice_status so a Sales Invoice can be saved as a
-- draft (no AR/GL post, no customer-credit apply) and later confirmed -> SENT.
-- Part of the Draft/Confirmed two-state rollout (mirrors the SO DRAFT model).
--
-- ALTER TYPE ... ADD VALUE only — kept ALONE in its own file. pg-migrate.mjs
-- wraps each file in one transaction; Postgres forbids USING a freshly-added
-- enum value in the same transaction that adds it, so no row may write/read
-- 'DRAFT' here. SET search_path = scm so the unqualified type resolves to scm.*
-- (pg-migrate's default search_path excludes scm). Idempotent via IF NOT EXISTS.

SET search_path = scm, public;

ALTER TYPE scm.sales_invoice_status ADD VALUE IF NOT EXISTS 'DRAFT' BEFORE 'SENT';
