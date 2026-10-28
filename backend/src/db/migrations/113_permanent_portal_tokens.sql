-- 113_permanent_portal_tokens.sql
-- D1 test mirror of migrations-pg/0076 — staff/sales portal tokens
-- become permanent (far-future expires_at).
UPDATE case_track_tokens
   SET expires_at = '9999-12-31T23:59:59.000Z'
 WHERE source IN ('staff', 'sales');
