-- ----------------------------------------------------------------------------
-- 0151_scm_mv_ar_aging.sql
--
-- scm.mv_ar_aging — a materialized snapshot of the AR-aging / Outstanding
-- summary that GET /api/scm/outstanding/summary computes live today.
--
-- WHY THIS EXISTS
--   The summary loops SEVEN Outstanding modules and, per module, counts + SUMs
--   every outstanding document (routes/outstanding.ts). scm-scaling-audit.md
--   named it "the worst time-bomb": is_outstanding is a computed CASE column
--   (not indexable), so each module is a full scan of its view, and the endpoint
--   pays all seven on every request. Correct today; O(rows) as debtor data
--   grows. perf-optimization-plan.md logged the next step as C-AR: a server
--   snapshot, once debtor data is large enough to warrant it.
--
--   This is that snapshot. It pre-aggregates the identical rollup — the SAME
--   filters, count and SUM columns the live path uses (SUMMARY_AGG in
--   routes/outstanding.ts) — into one row per (company_id, module). The endpoint
--   serves it behind ?snapshot=1; the live query stays the DEFAULT, because the
--   Outstanding page is a same-day operational dashboard and always requests a
--   user-chosen date range this all-time snapshot does not carry (see the PR).
--
-- FRESHNESS
--   The MV is rebuilt nightly by the 02:00 cron (src/index.ts) with REFRESH
--   MATERIALIZED VIEW CONCURRENTLY — hence the UNIQUE index below, which that
--   form REQUIRES. mv_ar_aging_meta.refreshed_at records the last successful
--   rebuild; the endpoint returns it as `refreshed_at` so Finance can see the
--   snapshot is a daily figure, not a live one.
--
-- COMPANY SCOPING (REQUIRED-half rule)
--   company_id is a COLUMN of the MV, and every read still scopes by it
--   (scopeToCompany), never a `??` default. It is COALESCE'd to 0 so the UNIQUE
--   index has no NULLs (NULLs would defeat REFRESH ... CONCURRENTLY). No real
--   company is id 0, so this is transparent to scoping: a resolved company
--   (.eq('company_id', X>0)) never matches the 0 bucket, and an unresolved read
--   (no predicate) sums every bucket — byte-identical to the live path's
--   .eq / no-filter behaviour on the underlying views.
--
-- SPLITTER CONTRACT (scripts/lib/split-sql.mjs): statements are split on ";\n".
--   Every statement below ends with ";" only at its terminator, and there are NO
--   dollar-quoted ($$) bodies here, so each is one clean statement. pg-migrate
--   runs the whole file in ONE transaction; CREATE MATERIALIZED VIEW ... WITH
--   DATA and a non-concurrent CREATE UNIQUE INDEX are both transaction-safe. The
--   CONCURRENTLY refresh is NOT here — it lives in the cron, run as its own
--   autocommit statement.
--
-- search_path is pinned to scm so the unqualified view refs inside the MV body
-- resolve to the scm views (matching how the outstanding views were created).
-- Idempotent + re-run-safe: DROP ... IF EXISTS + CREATE, CREATE TABLE IF NOT
-- EXISTS, INSERT ... ON CONFLICT.
-- ----------------------------------------------------------------------------

SET search_path TO scm, public;

-- The snapshot. One row per (company_id, module); count + SUM columns match
-- SUMMARY_AGG in routes/outstanding.ts exactly:
--   po  -> count, SUM(total_centi)
--   grn -> count
--   pi  -> count, SUM(total_centi), SUM(outstanding_centi)
--   pr  -> count
--   so  -> count, SUM(local_total_centi)
--   do  -> count
--   si  -> count, SUM(total_centi), SUM(outstanding_centi), and status <> DRAFT
--          (the DRAFT leak-guard: a DRAFT SI has not posted AR, so it is never
--          outstanding — mirrors the endpoint's .neq('status','DRAFT')).
-- Only is_outstanding rows are aggregated, the same filter the live path applies.
DROP MATERIALIZED VIEW IF EXISTS scm.mv_ar_aging;

CREATE MATERIALIZED VIEW scm.mv_ar_aging AS
  SELECT COALESCE(company_id, 0)::bigint AS company_id,
         'po'::text                      AS module,
         COUNT(*)::bigint                AS cnt,
         COALESCE(SUM(total_centi), 0)::bigint AS total_centi,
         0::bigint                       AS total_outstanding_centi
    FROM scm.v_po_outstanding
   WHERE is_outstanding
   GROUP BY COALESCE(company_id, 0)
  UNION ALL
  SELECT COALESCE(company_id, 0)::bigint, 'grn'::text,
         COUNT(*)::bigint, 0::bigint, 0::bigint
    FROM scm.v_grn_outstanding
   WHERE is_outstanding
   GROUP BY COALESCE(company_id, 0)
  UNION ALL
  SELECT COALESCE(company_id, 0)::bigint, 'pi'::text,
         COUNT(*)::bigint,
         COALESCE(SUM(total_centi), 0)::bigint,
         COALESCE(SUM(outstanding_centi), 0)::bigint
    FROM scm.v_pi_outstanding
   WHERE is_outstanding
   GROUP BY COALESCE(company_id, 0)
  UNION ALL
  SELECT COALESCE(company_id, 0)::bigint, 'pr'::text,
         COUNT(*)::bigint, 0::bigint, 0::bigint
    FROM scm.v_pr_outstanding
   WHERE is_outstanding
   GROUP BY COALESCE(company_id, 0)
  UNION ALL
  SELECT COALESCE(company_id, 0)::bigint, 'so'::text,
         COUNT(*)::bigint,
         COALESCE(SUM(local_total_centi), 0)::bigint,
         0::bigint
    FROM scm.v_so_outstanding
   WHERE is_outstanding
   GROUP BY COALESCE(company_id, 0)
  UNION ALL
  SELECT COALESCE(company_id, 0)::bigint, 'do'::text,
         COUNT(*)::bigint, 0::bigint, 0::bigint
    FROM scm.v_do_outstanding
   WHERE is_outstanding
   GROUP BY COALESCE(company_id, 0)
  UNION ALL
  SELECT COALESCE(company_id, 0)::bigint, 'si'::text,
         COUNT(*)::bigint,
         COALESCE(SUM(total_centi), 0)::bigint,
         COALESCE(SUM(outstanding_centi), 0)::bigint
    FROM scm.v_si_outstanding
   WHERE is_outstanding AND status <> 'DRAFT'
   GROUP BY COALESCE(company_id, 0);

-- REQUIRED by REFRESH MATERIALIZED VIEW CONCURRENTLY: a UNIQUE index covering
-- every row. (company_id, module) is unique by the GROUP BY above.
CREATE UNIQUE INDEX mv_ar_aging_company_module_uidx
  ON scm.mv_ar_aging (company_id, module);

GRANT SELECT ON scm.mv_ar_aging TO service_role;

-- Freshness companion: a single row holding the last successful REFRESH time.
-- Seeded now() because the MV above is created WITH DATA, so "just refreshed" is
-- honest at migration time. The nightly cron bumps it after each rebuild; if a
-- rebuild fails the stamp stays at the previous run — honestly stale, never a
-- lie about how fresh the numbers are.
CREATE TABLE IF NOT EXISTS scm.mv_ar_aging_meta (
  id           boolean PRIMARY KEY DEFAULT true,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mv_ar_aging_meta_singleton CHECK (id)
);

INSERT INTO scm.mv_ar_aging_meta (id, refreshed_at)
  VALUES (true, now())
  ON CONFLICT (id) DO UPDATE SET refreshed_at = EXCLUDED.refreshed_at;

GRANT SELECT, UPDATE ON scm.mv_ar_aging_meta TO service_role;

-- PostgREST caches the schema; nudge it so sb.from('mv_ar_aging') and
-- sb.from('mv_ar_aging_meta') resolve immediately after the deploy rather than
-- at the next periodic reload. Delivered on COMMIT, so it fires only if this
-- file actually applied.
NOTIFY pgrst, 'reload schema';
