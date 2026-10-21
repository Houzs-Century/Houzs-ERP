-- D1 test mirror of migrations-pg/20261021T1000_assr_verification_findings.sql.
ALTER TABLE assr_cases ADD COLUMN inspection_findings TEXT;
ALTER TABLE assr_cases ADD COLUMN next_action TEXT;
ALTER TABLE assr_cases ADD COLUMN pending_with TEXT;
