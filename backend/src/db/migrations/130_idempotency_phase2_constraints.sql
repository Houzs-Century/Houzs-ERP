-- Phase 2: D1 / SQLite parity for PG migration
-- 0171_idempotency_phase2_constraints.sql.
--
-- HARD DEPLOYMENT GATE: 128_idempotency_principal_company_hash.sql (Phase 1 on
-- D1) must be tracked, the durable Phase-1
-- Worker marker must have soaked for 24 hours, and no legacy NULL claim may
-- have appeared during that window. A fresh/offline environment can use the
-- exact one-hour bootstrap marker documented in the runbook. Guard statements
-- run before the first data/schema mutation, so a rejection leaves the Phase-1
-- table usable. Run this file as one Wrangler batch; never split the rebuild.

DROP TABLE IF EXISTS __idempotency_phase2_guard;
CREATE TABLE __idempotency_phase2_guard (
  ok INTEGER NOT NULL CONSTRAINT idempotency_phase2_gate CHECK (ok = 1)
);

INSERT INTO __idempotency_phase2_guard (ok)
SELECT 0
 WHERE NOT EXISTS (
   SELECT 1
     FROM _migrations
    WHERE name = '128_idempotency_principal_company_hash.sql'
 );

INSERT INTO __idempotency_phase2_guard (ok)
SELECT 0
 WHERE NOT (
   EXISTS (
     SELECT 1
       FROM app_settings AS worker_marker
       JOIN _migrations AS phase1
         ON phase1.name = '128_idempotency_principal_company_hash.sql'
      WHERE worker_marker.key = 'rollout.idempotency_phase1_worker_live'
        AND datetime(worker_marker.updated_at) >= datetime(phase1.applied_at)
        AND datetime(worker_marker.updated_at) <= datetime('now', '-24 hours')
   )
   OR EXISTS (
     SELECT 1
       FROM app_settings
      WHERE key = 'rollout.idempotency_phase2_offline_bootstrap'
        AND value = '{"mode":"offline-bootstrap","old_worker_traffic":"blocked"}'
        AND datetime(updated_at) >= datetime('now', '-1 hour')
        AND datetime(updated_at) <= datetime('now', '+5 minutes')
   )
 );

INSERT INTO __idempotency_phase2_guard (ok)
SELECT 0
 WHERE EXISTS (
   SELECT 1
     FROM idempotency_keys
    WHERE (user_id IS NULL OR tenant_scope IS NULL OR request_hash IS NULL)
      AND (
        datetime(created_at) IS NULL
        OR datetime(created_at) >= datetime('now', '-24 hours')
      )
 );

DROP TABLE __idempotency_phase2_guard;

DELETE FROM idempotency_keys
 WHERE (user_id IS NULL OR tenant_scope IS NULL OR request_hash IS NULL)
   AND datetime(created_at) < datetime('now', '-24 hours');

DROP TABLE IF EXISTS idempotency_keys_phase2;
CREATE TABLE idempotency_keys_phase2 (
  key            TEXT    NOT NULL,
  scope          TEXT    NOT NULL,
  user_id        INTEGER NOT NULL,
  status_code    INTEGER,
  response_body  TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  tenant_scope   TEXT    NOT NULL,
  request_hash   TEXT    NOT NULL,
  PRIMARY KEY (user_id, tenant_scope, key, scope)
);

INSERT INTO idempotency_keys_phase2
  (key, scope, user_id, status_code, response_body, created_at, tenant_scope, request_hash)
SELECT
  key, scope, user_id, status_code, response_body, created_at, tenant_scope, request_hash
  FROM idempotency_keys;

DROP TABLE idempotency_keys;
ALTER TABLE idempotency_keys_phase2 RENAME TO idempotency_keys;

CREATE INDEX idx_idempotency_keys_created_at
  ON idempotency_keys (created_at);

DELETE FROM app_settings
 WHERE key = 'rollout.idempotency_phase2_offline_bootstrap';
