-- Brand logos (owner 2026-07): per-brand letterhead logo for the SCM
-- Sales Order PDF. The R2 object key (POD_BUCKET, brands/logo-<id>-<ts>.<ext>)
-- is stored here; bytes live in R2, uploaded from Project Maintenance ->
-- Brands. NULL/'' = no logo (SO PDFs keep the company letterhead).
-- PG-only: project_brands predates the cutover on D1 (migration 044), but
-- this feature ships PG-first with no D1 stub.
ALTER TABLE project_brands ADD COLUMN IF NOT EXISTS logo_r2_key TEXT;
