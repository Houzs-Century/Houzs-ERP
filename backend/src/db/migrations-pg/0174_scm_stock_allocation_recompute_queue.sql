-- 0174_scm_stock_allocation_recompute_queue.sql
-- Durable singleton invalidation for the global SO stock-allocation projection.
-- A command updates source-of-truth rows and this queue row in the SAME DB
-- transaction. The inline drain is only a latency optimisation; the five-minute
-- cron retries the row until recompute succeeds, so a Worker crash cannot leave
-- READY/PENDING and the SO header permanently stale.

CREATE TABLE IF NOT EXISTS scm.stock_allocation_recompute_queue (
  job_key       text PRIMARY KEY DEFAULT 'GLOBAL' CHECK (job_key = 'GLOBAL'),
  request_token uuid NOT NULL DEFAULT gen_random_uuid(),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  reason        text,
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  locked_by     uuid,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Terminal state + separated counters (2026-07-22).
--   state / dead_lettered_at : after 10 consecutive HARD failures the job stops
--     retrying and is parked for a human. Without this a permanently broken
--     recompute spun every five minutes forever and never surfaced.
--   deferrals / next_attempt_at : a SOFT deferral (an SO header held by a human
--     editor, or another recompute already running) is NOT a failure and must
--     never dead-letter a healthy queue. It gets its own counter and a jittered
--     backoff, so the 5-minute edit lease and the 5-minute cron cannot beat
--     against each other indefinitely.
-- ADD COLUMN IF NOT EXISTS so a re-run over an already-created table is a no-op.
ALTER TABLE scm.stock_allocation_recompute_queue
  ADD COLUMN IF NOT EXISTS state            text NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz,
  ADD COLUMN IF NOT EXISTS deferrals        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at  timestamptz;

DO $$
BEGIN
  ALTER TABLE scm.stock_allocation_recompute_queue
    ADD CONSTRAINT stock_allocation_recompute_queue_state_check
    CHECK (state IN ('PENDING', 'DEAD'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE scm.stock_allocation_recompute_queue ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE scm.stock_allocation_recompute_queue TO service_role;

CREATE INDEX IF NOT EXISTS idx_stock_allocation_queue_lease
  ON scm.stock_allocation_recompute_queue (locked_until);

-- PostgREST calls do not share one PostgreSQL session, so a session advisory
-- lock acquired by one RPC cannot protect the reads/writes sent by later RPCs.
-- Every allocation entry point contends on this durable lease instead.
CREATE TABLE IF NOT EXISTS scm.stock_allocation_recompute_lock (
  lock_key     text PRIMARY KEY DEFAULT 'GLOBAL' CHECK (lock_key = 'GLOBAL'),
  locked_by    uuid,
  locked_until timestamptz
);

INSERT INTO scm.stock_allocation_recompute_lock (lock_key)
VALUES ('GLOBAL')
ON CONFLICT (lock_key) DO NOTHING;

ALTER TABLE scm.stock_allocation_recompute_lock ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE scm.stock_allocation_recompute_lock TO service_role;

NOTIFY pgrst, 'reload schema';
