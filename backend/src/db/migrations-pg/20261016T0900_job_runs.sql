-- 20261016T0900_job_runs.sql
-- REVERSAL: DROP TABLE IF EXISTS public.job_runs;
--   Revert the code first: services/jobRuns.ts writes a row per scheduled job
--   from scheduled() in index.ts, and routes/systemHealthJobs.ts reads them for
--   GET /api/admin/health/jobs. The rows are a 14-day run log, nothing else
--   reads them, so dropping the table loses only that history.
--   GRANTS: none to re-apply. Reached only through the Worker's own
--   connection; this file only revokes anon / authenticated.
-- Verified against: not yet applied anywhere; the normal migrate-before-deploy
--   path applies it on merge.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new
-- empty table and one index; no row written, nothing altered.
--
-- WHY (DEV-35, IT System Health): the cron jobs only console.log, so nobody can
-- tell whether a job ran or failed without the Cloudflare log tail. One row per
-- job run: inserted as 'running' when it starts, updated to 'ok' or 'error' with
-- its duration when it ends. A row left at 'running' means the Worker died
-- mid-job. The daily 02:00 slot deletes rows older than 14 days.

CREATE TABLE IF NOT EXISTS public.job_runs (
  id          uuid        NOT NULL PRIMARY KEY,
  job         text        NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'error')),
  error       text,
  duration_ms integer
);
CREATE INDEX IF NOT EXISTS idx_job_runs_job_started ON public.job_runs (job, started_at DESC);

-- Kept off the PostgREST anon / authenticated roles. RLS deliberately not
-- enabled (prod Hyperdrive role not named in this repo, see 0191).
REVOKE ALL ON public.job_runs FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON public.job_runs FROM anon; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON public.job_runs FROM authenticated; END IF; END $$;
