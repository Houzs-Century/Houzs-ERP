-- 0040_scm_do_status_draft.sql
-- Add 'DRAFT' to scm.do_status so a Delivery Order can be saved as a draft
-- (no stock OUT) and later confirmed -> DISPATCHED. Part of the Draft/Confirmed
-- two-state rollout for DO/SI/PO/GRN/PI (mirrors the existing SO DRAFT model).
--
-- ALTER TYPE ... ADD VALUE only — kept ALONE in its own file. pg-migrate.mjs
-- wraps each file in one transaction; Postgres forbids USING a freshly-added
-- enum value in the same transaction that adds it, so no row may write/read
-- 'DRAFT' here. SET search_path = scm so the unqualified type resolves to scm.*
-- (pg-migrate's default search_path excludes scm). Idempotent via IF NOT EXISTS.

SET search_path = scm, public;

ALTER TYPE scm.do_status ADD VALUE IF NOT EXISTS 'DRAFT' BEFORE 'LOADED';
