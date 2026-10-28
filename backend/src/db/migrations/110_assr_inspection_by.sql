-- D1 test-mirror of migrations-pg/0073_assr_inspection_by.sql.
-- Who performs the Pending Inspection stage: 'own' | 'supplier'.
ALTER TABLE assr_cases ADD COLUMN inspection_by TEXT;
