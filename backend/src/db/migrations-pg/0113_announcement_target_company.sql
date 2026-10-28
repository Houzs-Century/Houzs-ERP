-- 0113_announcement_target_company.sql (Postgres).
-- Company-targeting dimension for the UNIFIED announcements module.
--
-- Owner decision 2026-07: announcements stay ONE unified module (they already
-- target by dept / position / user across the merged team). We add COMPANY as
-- an additional target dimension: the author picks which company(ies) a notice
-- is for, and a reader only sees notices for a company they belong to
-- (user_companies grants → c.get('allowedCompanyIds'), fail-open to all).
--
-- Storage matches the sibling target_* columns (mig 0058): a TEXT column
-- holding a JSON array of integer company ids, e.g. '[1]' or '[1,2]'. Read /
-- written via the same readIntArray helper. NULL / empty = ALL companies
-- (visible to everyone) — the go-forward default for an untargeted "Both".
--
-- The pre-existing per-row company_id (mig 0093) is the AUTHORING company and
-- is unaffected; it is NO LONGER the visibility gate (target_company_ids is).
--
-- BACKFILL: existing rows were per-company-scoped by company_id (the OLD
-- "separate" model). To PRESERVE their current audience under the new unified
-- read path (and NOT leak a 2990 notice to Houzs or vice-versa), seed
-- target_company_ids = '[<company_id>]' for every existing row. New notices are
-- inserted AFTER this migration with target_company_ids set by the app (NULL
-- for "Both"), so the one-time backfill never touches them.
--
-- Idempotent + additive: ADD COLUMN IF NOT EXISTS; the backfill only fills rows
-- still NULL. Single-statement lines (no plpgsql) so the pg-migrate `;\n`
-- splitter runs each cleanly. announcements is org-wide, lives in public.

SET search_path = public, scm;

ALTER TABLE announcements ADD COLUMN IF NOT EXISTS target_company_ids text;

UPDATE announcements SET target_company_ids = '[' || company_id::text || ']' WHERE target_company_ids IS NULL AND company_id IS NOT NULL;
