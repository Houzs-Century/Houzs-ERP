-- Global immutable audit trail (Postgres / prod). Mirror of D1 mig 096.
--
-- Until now security-relevant mutations (role/permission edits, user invites
-- and status flips, finance edits) left no first-class, queryable record — you
-- could only reconstruct "who changed what" from worker logs. audit_events is
-- the append-only ledger: writeAudit() inserts one row per sensitive action
-- with the actor, the entity, a human summary and a JSON before/after blob.
-- Best-effort + fail-open at the call site, so an audit insert can never break
-- the mutation it records. No UPDATE/DELETE path in the app — append only.
-- Idempotent (IF NOT EXISTS) per pg-migrate.mjs's requirement.
CREATE TABLE IF NOT EXISTS audit_events (
  id          serial PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  actor_id    integer,                 -- NULL for system / cron actions
  actor_email text,
  action      text NOT NULL,           -- 'role.update', 'user.invite', 'finance.update', ...
  entity_type text,                    -- 'role','position','user','project_finance','order'
  entity_id   text,                    -- TEXT so non-integer keys (page_key, composite) fit
  summary     text,                    -- one-line human description
  meta        text,                    -- JSON: before/after, request detail
  ip          text,
  request_id  text
);

-- Time-ordered scan ("latest 50 events") is the default admin view.
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events (created_at);
-- "history of this entity" lookups.
CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events (entity_type, entity_id);
-- "everything this user did".
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events (actor_id);
