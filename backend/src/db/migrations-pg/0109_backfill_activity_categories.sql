-- 0109_backfill_activity_categories.sql
-- Sweep for mig 0108: rows created BEFORE mig 064 introduced the
-- category column were left NULL. 322 are old manual notes (internal —
-- the audience 'service' now covers) and 74 are SLA 'escalated' events
-- (auto-emitted — 'system'). Nothing customer-facing changes: the
-- customer portal only exposes category = 'customer'.

UPDATE assr_activity SET category = 'service'
 WHERE category IS NULL AND action = 'note';

UPDATE assr_activity SET category = 'system'
 WHERE category IS NULL AND action = 'escalated';
