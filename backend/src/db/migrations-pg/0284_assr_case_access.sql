-- 0284_assr_case_access.sql
--
-- Multi-person access list for service cases (owner 2026-09-09).
--
-- WHY. Row visibility for a scoped (non-director/non-manage) caller admits a
-- case only when created_by / assigned_to / assigned_to_2 is in their reporting
-- subtree, or the free-text sales_agent name matches (see
-- docs/modules/service-case.md section 6). That gives a case ONE salesperson +
-- TWO assignee slots. Ops needs to keep the SALESPERSON on the original rep
-- (sales attribution) while letting an OPEN-ENDED set of other staff reach the
-- case - e.g. Kingsley stays the salesperson while Stanley, Shawn (and more
-- later) work it. Two slots cannot express "four+ people", so this table is the
-- Nth-person reach. It NEVER touches sales_agent.
--
-- SHAPE. One row per (case, granted user). The grant is a preference, not a
-- dependency; the same additive OR-branch the id-scope already uses reads it:
--   OR EXISTS (SELECT 1 FROM assr_case_access a
--              WHERE a.assr_id = c.id AND a.user_id IN (<caller subtree ids>))
-- so a granted user AND their upline reach the case, exactly like assigned_to.
-- The four visibility touchpoints that must carry the same clause are listed in
-- the module guide; they change together with this migration.
--
-- CREATING THIS TABLE CHANGES NOTHING ON ITS OWN. Empty table = no EXISTS row
-- ever matches = every case's visibility is byte-identical to today. Behaviour
-- changes only when a human grants access in the UI (POST /api/assr/:id/access),
-- a deliberate act gated on service_cases.write. Safe to apply live.
--
-- assr_cases lives in PUBLIC (not scm) and its user columns are BIGINT
-- (assigned_to_2 / company_id, migs 0075 / 0083). This table matches: BIGINT
-- user ids, no FK to users (mirrors assigned_to, which carries none), FK to
-- assr_cases with ON DELETE CASCADE so grants die with a hard-deleted case.
--
-- Houzs conventions: additive, IF NOT EXISTS, re-runnable; the pg-migrate runner
-- owns ONE transaction, so NO inner BEGIN/COMMIT; one-line DO block (the runner
-- splits on ';\n').

CREATE TABLE IF NOT EXISTS public.assr_case_access (
  assr_id    bigint      NOT NULL,
  user_id    bigint      NOT NULL,
  added_by   bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assr_id, user_id)
);

-- Grants die with the case. Additive; guarded so a re-run is a no-op.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assr_case_access_assr_id_fkey') THEN ALTER TABLE public.assr_case_access ADD CONSTRAINT assr_case_access_assr_id_fkey FOREIGN KEY (assr_id) REFERENCES public.assr_cases(id) ON DELETE CASCADE; END IF; END $$;

-- The PK (assr_id, user_id) already backs the per-case EXISTS lookup. This index
-- backs the reverse question - "which cases can user X reach" - the way
-- idx_assr_assigned backs assigned_to.
CREATE INDEX IF NOT EXISTS idx_assr_case_access_user ON public.assr_case_access (user_id);

COMMENT ON TABLE public.assr_case_access IS
  'Nth-person access list for service cases: one row per (assr_id, user_id) granting a staff member (and their upline) row visibility on a case WITHOUT changing sales_agent or the two assigned_to slots. Read as an additive OR-branch by all four ASSR visibility touchpoints - see docs/modules/service-case.md section 6. Empty table = no behaviour change. Granted via POST /api/assr/:id/access (service_cases.write).';
