-- scm.app_config — a tiny key/value table for operational switches that must be
-- flippable WITHOUT a deploy.
--
-- First user: the go-live write freeze (owner 2026-08-10, "暂时把整个 ERP 的
-- edit 和 create 功能也关掉"). scm/lib/write-freeze.ts reads key
-- 'scm.write_freeze' on every non-GET /api/scm request (30s cache) and refuses
-- writes for the companies listed in `value` ('off' | 'all' | '1' | '1,3').
--
-- In the `scm` schema, not `public`: the service client is created with
-- db.schema = 'scm' (db/supabase.ts), so an unqualified sb.from('app_config')
-- resolves here. The 2990 schema dump carries a public.app_config that this
-- database never had — the first freeze dispatch failed on exactly that.
--
-- Seeded OPEN. Turning the freeze on is an explicit act (set-write-freeze
-- workflow), never a side effect of running a migration.
CREATE TABLE IF NOT EXISTS scm.app_config (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid
);

INSERT INTO scm.app_config (key, value, description)
VALUES ('scm.write_freeze', 'off', NULL)
ON CONFLICT (key) DO NOTHING;
