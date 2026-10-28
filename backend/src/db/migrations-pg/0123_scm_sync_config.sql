-- 0123_scm_sync_config.sql — the DB-row kill switch for cross-system sync.
--
-- D8 (docs/2990-mirror-full-design.md): kill switches live in the database, not
-- in env vars. A deploy is not a safe emergency lever on this stack — the PWA
-- service-worker cache churns, Hyperdrive cold-starts throw 503s right after a
-- deploy, and burst-deploying multiplies both. Flipping a row is instant and
-- needs no deploy. This mirrors 2990's own sync_config(k, v) table.
--
-- Read by scm/routes/maintenance-push.ts. The keys it looks for:
--   maintenance_push_enabled = 'true'  → POST /maintenance-push/apply may write
--                                        to 2990. ANY other value, or no row at
--                                        all, means disabled.
--
-- DEFAULT OFF BY ABSENCE — deliberately no seed. An empty table is a disabled
-- feature, so the push ships dark on the strength of this file alone, with no
-- follow-up data step that someone could forget. Enabling is an explicit,
-- auditable INSERT the owner runs when he is ready. Disabling is a DELETE or an
-- UPDATE to 'false' and takes effect on the next request.
--
-- Fail-closed: the route treats a read error (table absent, PostgREST cache
-- cold) as disabled, never as enabled.
--
-- Houzs conventions: schema-qualified to scm.*, no inner BEGIN/COMMIT (pg-migrate
-- owns the transaction). The runner splits this file on ";\n" BEFORE it strips
-- comment lines, so no comment here ends in a semicolon.
CREATE TABLE IF NOT EXISTS scm.sync_config (
  k text PRIMARY KEY,
  v text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
