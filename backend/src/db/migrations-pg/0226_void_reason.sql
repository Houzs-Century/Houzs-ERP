-- Void reason (Nico 2026-07-29): when a case is moved to the terminal
-- 'voided' stage, ops records WHY it's not valid / not warranty-covered
-- (mirrors the Close-Case satisfaction prompt). Plain nullable column.
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS void_reason text;
