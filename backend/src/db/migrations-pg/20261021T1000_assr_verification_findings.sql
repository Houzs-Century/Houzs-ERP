-- 20261021T1000_assr_verification_findings.sql
-- REVERSAL:
--   ALTER TABLE assr_cases DROP COLUMN IF EXISTS inspection_findings;
--   ALTER TABLE assr_cases DROP COLUMN IF EXISTS next_action;
--   ALTER TABLE assr_cases DROP COLUMN IF EXISTS pending_with;
--   The columns are new and nullable; dropping them loses only what was typed
--   on the Verification step. GRANTS: none touched.
--
-- HC-0133 (Operation Dept, 2026-10-20): the Verification step records what the
-- inspection found and who the case now waits on, next to the existing
-- verified_root_cause. Allowed values are checked at the API
-- (scm/shared/assr-verification-fields.ts), not by a CHECK constraint.
--   inspection_findings  free text: what was checked, found and done
--   next_action          free text: repair on-site, pickup for service, ...
--   pending_with         'supplier' | 'production' | 'logistics' | 'customer' | 'management' | NULL
SET search_path = public;

ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS inspection_findings text;
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS next_action text;
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS pending_with text;
