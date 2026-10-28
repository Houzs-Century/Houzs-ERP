-- 0044_scm_purchase_invoice_status_draft.sql
-- Re-add 'DRAFT' to scm.purchase_invoice_status so a Purchase Invoice can be
-- saved as a draft (no AP/GL post, no GRN invoiced-qty consume) and later
-- confirmed -> POSTED. Part of the Draft/Confirmed two-state rollout (mirrors
-- the SO DRAFT model). NOTE: migration 0078 (2990) previously removed DRAFT
-- from this enum; this is a deliberate re-add per the Draft/Confirmed plan.
--
-- ALTER TYPE ... ADD VALUE only — kept ALONE in its own file. pg-migrate.mjs
-- wraps each file in one transaction; Postgres forbids USING a freshly-added
-- enum value in the same transaction that adds it, so no row may write/read
-- 'DRAFT' here. SET search_path = scm so the unqualified type resolves to scm.*
-- (pg-migrate's default search_path excludes scm). Idempotent via IF NOT EXISTS.

SET search_path = scm, public;

ALTER TYPE scm.purchase_invoice_status ADD VALUE IF NOT EXISTS 'DRAFT' BEFORE 'POSTED';
