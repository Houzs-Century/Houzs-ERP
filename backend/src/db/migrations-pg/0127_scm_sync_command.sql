-- 0127_scm_sync_command.sql — the command queue for the Houzs -> 2990 amendment
-- write-back (design docs/2990-mirror-full-design.md §3.2, D2: command-mirror,
-- not state-merge).
--
-- When the owner approves/rejects a MIRRORED (2990-) amendment in Houzs, Houzs
-- does NOT write the row (so-mirror would revert it, F2). Instead it enqueues a
-- row here and calls 2990's own API, which applies it with 2990's logic
-- (snapshot + line diff + honest-pricing recompute + delivery-fee re-derive +
-- revision bump). The resulting state change flows back down the EXISTING mirror.
-- This table is that command's durable state — so a failed dispatch is retried,
-- never lost.
--
-- Idempotency has TWO layers (§3.2):
--   1. idempotency_key = sha256(entity|entity_key|action|target_status), UNIQUE.
--      The same decision cannot enqueue twice.
--   2. 2990's state machine is the real guard: on retry, if 2990 already applied
--      it, its API returns 409 bad_transition; the dispatcher reads the
--      amendment's status back and treats "at or past target" as CONVERGED, not
--      failed. That logic lives in scm/lib/amendment-command.ts, not here.
--
-- status: PENDING -> SENT (in-flight) -> DONE | CONVERGED | FAILED.
--   DONE      = 2990 applied it on this dispatch (2xx).
--   CONVERGED = 2990 had already applied it (409 + status read-back at/past target).
--   FAILED    = attempts exhausted, or 2990 refused in a way that is not convergence.
--
-- requested_by is the REAL Houzs public.users id (c.get('houzsUser').id), the
-- authoritative record of who approved (§3.5). NEVER the pinned SCM system `user`
-- — the bridge overwrites `user` with one shared staff row, and trusting it
-- shipped the pos-cart leak #633. 2990's own row will read the bridge account;
-- the truth of who dispatched lives here.
--
-- Houzs conventions: schema-qualified scm.*, additive + re-run-safe, no inner
-- BEGIN/COMMIT (pg-migrate owns the transaction) and no DO $$ / dollar-quoting
-- (the runner splits this file on ";\n" BEFORE stripping comments, so a $$ block
-- would fragment). No comment line here ends in a semicolon, for the same reason.
-- gen_random_uuid() is already the default on the mig-0080 amendment tables, so
-- pgcrypto is present.
CREATE TABLE IF NOT EXISTS scm.sync_command (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity          text NOT NULL,
  entity_key      text NOT NULL,
  action          text NOT NULL,
  target_status   text,
  payload         jsonb,
  idempotency_key text NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING',
  requested_by    bigint,
  company_id      bigint,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

-- Layer-1 idempotency: the same (entity, entity_key, action, target_status)
-- decision hashes to one key and cannot be enqueued twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_command_idem ON scm.sync_command (idempotency_key);

-- The drain sweep reads only retryable rows, oldest first.
CREATE INDEX IF NOT EXISTS idx_sync_command_pending ON scm.sync_command (created_at) WHERE status IN ('PENDING','SENT');

-- Lookups by target amendment (UI "Approving…" state, diagnostics).
CREATE INDEX IF NOT EXISTS idx_sync_command_entity ON scm.sync_command (entity, entity_key);
