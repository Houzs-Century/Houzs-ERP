-- 0042_scm_po_status_draft.sql
-- Re-add 'DRAFT' to scm.po_status so a Purchase Order can be saved as a draft
-- (no SO-picked advance, invisible to MRP supply) and later confirmed ->
-- SUBMITTED. Part of the Draft/Confirmed two-state rollout (mirrors the SO
-- DRAFT model). NOTE: migration 0078 (2990) previously removed DRAFT from this
-- enum; this is a deliberate re-add per the Draft/Confirmed plan.
--
-- ALTER TYPE ... ADD VALUE only — kept ALONE in its own file. pg-migrate.mjs
-- wraps each file in one transaction; Postgres forbids USING a freshly-added
-- enum value in the same transaction that adds it, so no row may write/read
-- 'DRAFT' here. SET search_path = scm so the unqualified type resolves to scm.*
-- (pg-migrate's default search_path excludes scm). Idempotent via IF NOT EXISTS.

SET search_path = scm, public;

ALTER TYPE scm.po_status ADD VALUE IF NOT EXISTS 'DRAFT' BEFORE 'SUBMITTED';
