-- Service / Exchange logistics trip (owner 2026-07-22): a mid-fair service
-- visit or part exchange, mirroring the setup/dismantle crew editor. Stored as
-- a JSON blob (lorry_crew / drivers / helpers / lorries / outsourced / remark),
-- the same shape as setup_crew / dismantle_crew. Service photos reuse
-- project_phase_photos with phase = 'service'.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS service_crew text;
