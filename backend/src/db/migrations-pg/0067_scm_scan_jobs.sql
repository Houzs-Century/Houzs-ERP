-- 0067_scm_scan_jobs.sql
-- Background scan-to-draft-SO jobs (POST /api/scm/scan-so/enqueue).
--
-- The mobile Scan screen's OCR flow used to be client-driven: the phone waited
-- on POST /scan-so/extract and then POSTed the DRAFT SO itself — closing the
-- app killed the order. /enqueue now persists the slip photo(s) + this job row
-- FIRST, returns immediately, and finishes the OCR + DRAFT-SO create inside
-- ctx.waitUntil. This table is the job's durable state the mobile screen polls
-- (GET /scan-so/jobs/:id, GET /scan-so/jobs?salesperson=).
--
--   status          queued | running | done | error
--   salesperson     rep display name captured at enqueue, normalized
--                   (trimmed, single-spaced) so case/whitespace variants share
--                   one pool — reads filter with ilike (HOOKKA
--                   BUG-2026-06-07-012 class).
--   salesperson_id  scm.staff UUID captured from the authed enqueue request;
--                   replayed into the headless SO create as created_by.
--   houzs_user_id   public.users bigint id captured at enqueue; drives the
--                   venue-by-active-project auto-fill in the SO create.
--   image_keys      jsonb array of R2 keys (SO_ITEM_PHOTOS bucket,
--                   scan-jobs/{jobId}/{n}) — durability/audit copy of the
--                   uploaded photos.
--   so_doc_no       the minted DRAFT SO doc_no once status = done.
--   error           SHORT plain-language failure message (never a raw
--                   exception / status code) once status = error.
--
-- Postgres-only — SCM has no D1 twin (precedent: 0066; an empty D1 stub file
-- breaks the D1 test runner). ADDITIVE + idempotent. Outer BEGIN;/COMMIT;
-- omitted — pg-migrate.mjs wraps the whole file in one transaction.

CREATE TABLE IF NOT EXISTS scm.scan_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status          text NOT NULL DEFAULT 'queued',
  salesperson     text,
  salesperson_id  uuid,
  houzs_user_id   bigint,
  image_keys      jsonb NOT NULL DEFAULT '[]'::jsonb,
  sample_id       uuid,
  so_doc_no       text,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Poll patterns: latest jobs for one rep (ilike on the normalized name) and
-- direct id lookups (PK). created_at DESC keeps the "latest 20" list cheap.
CREATE INDEX IF NOT EXISTS scan_jobs_created_at_idx
  ON scm.scan_jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS scan_jobs_salesperson_idx
  ON scm.scan_jobs (salesperson);
