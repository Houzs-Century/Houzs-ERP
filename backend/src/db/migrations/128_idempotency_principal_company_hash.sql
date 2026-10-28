-- D1 / SQLite parity for PG migration 0163 (phase 1 additive rollout).
-- Keep the legacy (key, scope) primary key until the hardened middleware has
-- deployed everywhere; see the PostgreSQL migration for the rollout contract.

ALTER TABLE idempotency_keys ADD COLUMN tenant_scope TEXT;
ALTER TABLE idempotency_keys ADD COLUMN request_hash TEXT;
