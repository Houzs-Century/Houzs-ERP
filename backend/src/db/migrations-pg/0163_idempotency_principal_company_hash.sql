-- Phase 1: additive idempotency ownership + payload columns (Postgres / prod).
--
-- Deploy order is migration -> Worker. Keep both columns nullable and retain
-- the legacy (key, scope) primary key so the OLD middleware can continue to
-- insert and de-duplicate safely while old Worker isolates drain. The new
-- middleware always writes and queries both columns; a legacy global-PK
-- collision is blocked, never replayed across principals/companies.
--
-- A later migration, deployed only after the new Worker is fully live, will
-- invalidate null legacy rows, set NOT NULL and replace the primary key with
-- (user_id, tenant_scope, key, scope). Splitting the rollout avoids a window in
-- which the old fail-open middleware cannot insert because new NOT NULL columns
-- have already landed.

ALTER TABLE public.idempotency_keys
  ADD COLUMN IF NOT EXISTS tenant_scope text,
  ADD COLUMN IF NOT EXISTS request_hash text;
