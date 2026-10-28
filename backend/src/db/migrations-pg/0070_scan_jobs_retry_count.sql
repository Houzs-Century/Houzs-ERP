-- 0070_scan_jobs_retry_count.sql
-- One-shot AUTO-RETRY for deploy-killed background scan jobs.
--
-- Every Worker deploy evicts in-flight waitUntil pipelines, leaving
-- scm.scan_jobs rows stuck queued/running forever. The read-time reaper
-- (PR #252) used to flip them straight to a terminal error after 10 minutes;
-- now it first RE-RUNS the job once (the slip photos are already durable in
-- R2 under scan-jobs/{jobId}/{n} — image_keys on the row), and only errors
-- jobs that already used their retry.
--
--   retry_count   0 = never retried (a stale job gets one automatic re-run);
--                 1 = the reaper's single retry was spent — the next
--                 staleness makes the job a terminal error.
--
-- Postgres-only — SCM has no D1 twin (precedent: 0066/0067; an empty D1 stub
-- file breaks the D1 test runner). ADDITIVE + idempotent. Outer BEGIN;/COMMIT;
-- omitted — pg-migrate.mjs wraps the whole file in one transaction.

ALTER TABLE scm.scan_jobs
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0;
