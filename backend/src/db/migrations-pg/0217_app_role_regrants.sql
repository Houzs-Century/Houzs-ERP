-- 0217_app_role_regrants.sql — re-assert app-role grants after object
-- recreation (mig-0189 second-order class, staging edition).
-- OWNER-APPROVED + owner-executed 2026-07-27 ("那就B / 批准加授权迁移").
-- Restores service_role (PostgREST path) + hyperdrive_staging (staging-only
-- pg-driver path; conditional so prod cannot fail) to their normal working
-- set. authenticated/anon deliberately untouched. Idempotent.

GRANT USAGE ON SCHEMA public TO service_role;
GRANT USAGE ON SCHEMA scm TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA scm TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA scm TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA scm TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA scm GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hyperdrive_staging') THEN GRANT USAGE ON SCHEMA public TO hyperdrive_staging; GRANT USAGE ON SCHEMA scm TO hyperdrive_staging; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hyperdrive_staging; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA scm TO hyperdrive_staging; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hyperdrive_staging; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA scm TO hyperdrive_staging; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO hyperdrive_staging; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA scm TO hyperdrive_staging; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hyperdrive_staging; ALTER DEFAULT PRIVILEGES IN SCHEMA scm GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hyperdrive_staging; END IF; END $$;
