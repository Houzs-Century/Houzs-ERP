-- 20261008T1005_scm_job_progress.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.job_progress;
--           ALTER TABLE scm.delivery_orders DROP COLUMN IF EXISTS pod_photo_keys;
--   Revert the code first (routes/delivery-job-progress.ts reads and writes it).
--   GRANTS: none to re-apply — the table rides the scm schema's default
--   privileges (service_role), like scm.trip_locations.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new
-- empty table and its indexes, and one nullable-free JSONB column with a
-- constant default on scm.delivery_orders (metadata-only in PG 11+); no
-- existing value is rewritten.
-- Verified against: the local restore of production (houzs_local, 2026-10-08).
--
-- WHY (owner, 2026-10-07: every job needs On the way -> Arrived -> POD, and
-- "每个 Job 都必须上传 POD"). Only a Delivery Order had anywhere to keep that:
-- delivery_orders.departure_at / arrival_at / delivered_at / pod_r2_key. A
-- Setup, Dismantle, Service Case leg, Supplier pickup, Transfer or Lorry service
-- job had no departure, arrival, completion or photo column at all, so the
-- phone could not record them and the office could not see them.
--
-- One row per job LEG, keyed by the same identity the delivery board uses:
--   source_type 'dp'      source_id = scm.dp_orders.id,  leg = dp job_type
--   source_type 'project' source_id = public.projects.id, leg = SETUP | DISMANTLE
--   source_type 'assr'    source_id = public.assr_cases.id,
--                         leg = customer_pickup | inspection | delivery
-- A Delivery Order keeps its POD on scm.delivery_orders, unchanged.
--
-- Times are SERVER times stamped when the crew taps; *_by is the public.users id.
-- pod_photo_keys is a JSON array of R2 keys in the shared houzs-erp bucket.

CREATE TABLE IF NOT EXISTS scm.job_progress (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       BIGINT,
  source_type      TEXT NOT NULL CHECK (source_type IN ('dp', 'project', 'assr')),
  source_id        TEXT NOT NULL,
  leg              TEXT NOT NULL,
  trip_id          UUID,
  departed_at      TIMESTAMPTZ,
  departed_by      BIGINT,
  arrived_at       TIMESTAMPTZ,
  arrived_by       BIGINT,
  completed_at     TIMESTAMPTZ,
  completed_by     BIGINT,
  pod_photo_keys   JSONB NOT NULL DEFAULT '[]'::jsonb,
  pod_notes        TEXT,
  pod_lat          DOUBLE PRECISION,
  pod_lng          DOUBLE PRECISION,
  pod_accuracy_m   DOUBLE PRECISION,
  pod_located_at   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT job_progress_one_row_per_leg UNIQUE (source_type, source_id, leg)
);

CREATE INDEX IF NOT EXISTS idx_job_progress_trip ON scm.job_progress (trip_id);
CREATE INDEX IF NOT EXISTS idx_job_progress_completed ON scm.job_progress (completed_at);

-- A delivery takes more than one photo (goods unloaded, installed, the signed
-- note). pod_r2_key keeps the first for every reader that already uses it;
-- pod_photo_keys holds them all.
ALTER TABLE scm.delivery_orders ADD COLUMN IF NOT EXISTS pod_photo_keys JSONB NOT NULL DEFAULT '[]'::jsonb;
