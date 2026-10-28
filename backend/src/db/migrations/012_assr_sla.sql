-- 012_assr_sla.sql
-- Response-time SLA tracking for ASSR cases.
--
-- sla_hours: how many hours from created_at until the case must be closed
-- deadline_at: the absolute datetime. Kept as its own column so ops can
--   manually extend/override without recomputing from priority.
-- escalated_at: set when an escalation notice is dispatched (future hook).

ALTER TABLE assr_cases ADD COLUMN sla_hours INTEGER;
ALTER TABLE assr_cases ADD COLUMN deadline_at TEXT;
ALTER TABLE assr_cases ADD COLUMN escalated_at TEXT;

-- Backfill deadlines based on priority for existing open cases.
-- Priority → SLA hours mapping:
--   urgent = 24h, high = 72h, normal = 168h (7d), low = 336h (14d)
UPDATE assr_cases
   SET sla_hours = CASE priority
                     WHEN 'urgent' THEN 24
                     WHEN 'high'   THEN 72
                     WHEN 'low'    THEN 336
                     ELSE 168
                   END
 WHERE sla_hours IS NULL;

UPDATE assr_cases
   SET deadline_at = datetime(created_at, '+' || sla_hours || ' hours')
 WHERE deadline_at IS NULL AND sla_hours IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_assr_deadline ON assr_cases(deadline_at);
