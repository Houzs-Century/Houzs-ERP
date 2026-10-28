-- 0075_assr_assigned_to_2.sql
-- Co-assignee on service cases (Nick 2026-07-06): the after-sales
-- desk is run by two people, so a case can carry a second responsible
-- user next to assigned_to. Google-Form intake fills both from the
-- assr_default_assignee_id / assr_default_assignee2_id settings.
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS assigned_to_2 BIGINT;
