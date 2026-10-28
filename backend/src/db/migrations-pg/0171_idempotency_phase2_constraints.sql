-- Phase 2: make idempotency ownership/payload binding structural (Postgres).
--
-- HARD DEPLOYMENT GATE: this file must not ship in the same migration run as
-- Phase 1 (0163_idempotency_principal_company_hash.sql). The durable Worker
-- marker enforces a 24-hour soak, while the row check proves no old Worker has
-- written a legacy NULL claim during that window. The deploy must keep running
-- the Phase-1 Worker if either check fails.
--
-- RENUMBERING: the Phase-1 filename below is a hard-coded literal. If Phase 1
-- is ever renumbered, this gate silently becomes a guaranteed RAISE and a
-- failed migration aborts pg-migrate.mjs, blocking every later file. The test
-- "the Phase-1 filename this migration gates on actually exists in the tree"
-- in backend/tests/idempotencyPhase2Migration.test.ts is what catches that.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE;

DO $phase2_gate$
DECLARE
  phase1_applied_at timestamptz;
  phase1_worker_live_at timestamptz;
  offline_bootstrap_at timestamptz;
BEGIN
  SELECT applied_at
    INTO phase1_applied_at
    FROM public._pg_migrations
   WHERE filename = '0163_idempotency_principal_company_hash.sql';

  IF phase1_applied_at IS NULL THEN
    RAISE EXCEPTION
      'idempotency phase 2 blocked: migration 0163_idempotency_principal_company_hash.sql is not tracked';
  END IF;

  -- app_settings.updated_at is TEXT (the D1-compat shim writes SQLite's
  -- 'YYYY-MM-DD HH:MM:SS' in UTC — see src/db/d1-compat.ts). A bare
  -- ::timestamptz cast would resolve that text in the SESSION time zone, so a
  -- non-UTC session would read the marker as up to its UTC offset OLDER than
  -- it is and let the soak pass early. Pin the source zone explicitly.
  SELECT (updated_at::timestamp AT TIME ZONE 'UTC')
    INTO phase1_worker_live_at
    FROM public.app_settings
   WHERE key = 'rollout.idempotency_phase1_worker_live';

  SELECT (updated_at::timestamp AT TIME ZONE 'UTC')
    INTO offline_bootstrap_at
    FROM public.app_settings
   WHERE key = 'rollout.idempotency_phase2_offline_bootstrap'
     AND value = '{"mode":"offline-bootstrap","old_worker_traffic":"blocked"}';

  IF offline_bootstrap_at IS NULL
     OR offline_bootstrap_at < now() - interval '1 hour'
     OR offline_bootstrap_at > now() + interval '5 minutes' THEN
    IF phase1_worker_live_at IS NULL
       OR phase1_worker_live_at < phase1_applied_at
       OR phase1_worker_live_at > now() - interval '24 hours' THEN
      RAISE EXCEPTION
        'idempotency phase 2 blocked: the Phase-1 Worker live marker must soak for 24 hours';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.idempotency_keys
     WHERE (user_id IS NULL OR tenant_scope IS NULL OR request_hash IS NULL)
       AND created_at >= now() - interval '24 hours'
  ) THEN
    RAISE EXCEPTION
      'idempotency phase 2 blocked: a legacy NULL claim was written in the last 24 hours';
  END IF;

END
$phase2_gate$;

-- NULL claims older than the replay/observation window cannot be replayed by
-- the Phase-1 middleware and are safe to expire before enforcing constraints.
DELETE FROM public.idempotency_keys
 WHERE (user_id IS NULL OR tenant_scope IS NULL OR request_hash IS NULL)
   AND created_at < now() - interval '24 hours';

ALTER TABLE public.idempotency_keys
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN tenant_scope SET NOT NULL,
  ALTER COLUMN request_hash SET NOT NULL;

DO $replace_primary_key$
DECLARE
  old_primary_key name;
  old_primary_key_columns text[];
BEGIN
  SELECT constraint_row.conname,
         array_agg(attribute_row.attname::text ORDER BY key_column.ordinality)
    INTO old_primary_key, old_primary_key_columns
    FROM pg_constraint AS constraint_row
    CROSS JOIN LATERAL unnest(constraint_row.conkey)
      WITH ORDINALITY AS key_column(attnum, ordinality)
    JOIN pg_attribute AS attribute_row
      ON attribute_row.attrelid = constraint_row.conrelid
     AND attribute_row.attnum = key_column.attnum
   WHERE constraint_row.conrelid = 'public.idempotency_keys'::regclass
     AND constraint_row.contype = 'p'
   GROUP BY constraint_row.conname;

  IF old_primary_key IS NULL THEN
    RAISE EXCEPTION 'idempotency phase 2 blocked: idempotency_keys has no primary key';
  END IF;

  IF old_primary_key_columns = ARRAY['user_id', 'tenant_scope', 'key', 'scope'] THEN
    RETURN;
  END IF;

  IF old_primary_key_columns <> ARRAY['key', 'scope'] THEN
    RAISE EXCEPTION
      'idempotency phase 2 blocked: unexpected primary key columns %',
      old_primary_key_columns;
  END IF;

  EXECUTE format(
    'ALTER TABLE public.idempotency_keys DROP CONSTRAINT %I',
    old_primary_key
  );

  EXECUTE 'ALTER TABLE public.idempotency_keys ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (user_id, tenant_scope, key, scope)';
END
$replace_primary_key$;

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at
  ON public.idempotency_keys (created_at);

DELETE FROM public.app_settings
 WHERE key = 'rollout.idempotency_phase2_offline_bootstrap';
