-- Idempotency keys (Postgres / prod).
--
-- De-dupes retried or double-submitted mutating requests so that a client
-- retry after a 503 (the 2026-06-13 cold-pool failure mode) does NOT create
-- a duplicate order / DO / PO. Opt-in: the middleware only consults this
-- table when the client sends an `Idempotency-Key` header, and it fails open
-- if the table is absent, so this migration is safe to apply at any time.
--
-- Idempotent (IF NOT EXISTS) per pg-migrate.mjs's requirement.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key            text        NOT NULL,
  -- "METHOD /path" — scopes the key to one route so the same key reused on a
  -- different endpoint can't accidentally replay the wrong response.
  scope          text        NOT NULL,
  user_id        integer,
  -- NULL while the original request is in flight; set once its response is
  -- captured. A non-NULL row is a completed, replayable response.
  status_code    integer,
  response_body  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, scope)
);

-- Supports the daily TTL sweep (delete rows older than the retention window).
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at
  ON idempotency_keys (created_at);
